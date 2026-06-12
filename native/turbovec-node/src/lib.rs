#![deny(clippy::all)]

use std::collections::HashMap;
use std::path::Path;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use turbovec::IdMapIndex;

// ── FNV-1a 64-bit hash ────────────────────────────────────────────────────────

/// Map a string ID to a stable u64 for turbovec's IdMapIndex.
fn fnv1a_64(s: &str) -> u64 {
    let mut hash: u64 = 14695981039346656037;
    for byte in s.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(1099511628211);
    }
    hash
}

// ── Types ─────────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct SearchResult {
    pub id: String,
    pub score: f64,
}

// ── TurboVecIndex ─────────────────────────────────────────────────────────────

/// Node-API wrapper around turbovec's `IdMapIndex`.
///
/// String IDs from JavaScript are hashed to u64 via FNV-1a and stored in
/// `id_map` for reverse lookup.  Turbovec itself only knows the u64 hashes;
/// the sidecar `.ids` file (JSON) persists the hash→string table alongside
/// the binary index so both survive a save/load round-trip.
#[napi]
pub struct TurboVecIndex {
    inner: Option<IdMapIndex>,
    id_map: HashMap<u64, String>,
    dim: usize,
    bit_width: usize,
}

#[napi]
impl TurboVecIndex {
    /// Create a new empty index.
    ///
    /// - `dim`: embedding dimension, must be a positive multiple of 8.
    /// - `bit_width`: compression level — 2, 3, or 4 bits per coordinate.
    #[napi(constructor)]
    pub fn new(dim: u32, bit_width: u32) -> Result<Self> {
        let dim = dim as usize;
        let bit_width = bit_width as usize;
        let inner = IdMapIndex::new(dim, bit_width)
            .map_err(|e| Error::new(Status::InvalidArg, format!("{e:?}")))?;
        Ok(Self {
            inner: Some(inner),
            id_map: HashMap::new(),
            dim,
            bit_width,
        })
    }

    /// Load a previously saved index from `bin_path`.
    ///
    /// Reads the turbovec binary (`bin_path`) and the JSON ID sidecar
    /// (`bin_path + ".ids"`).
    #[napi(factory)]
    pub fn load(bin_path: String) -> Result<Self> {
        let inner = IdMapIndex::load(&bin_path)
            .map_err(|e| Error::new(Status::GenericFailure, format!("load failed: {e}")))?;

        let dim = inner.dim();
        let bit_width = inner.bit_width();

        let ids_path = bin_path.clone() + ".ids";
        let id_map: HashMap<u64, String> = if Path::new(&ids_path).exists() {
            let json = std::fs::read_to_string(&ids_path).map_err(|e| {
                Error::new(Status::GenericFailure, format!("read ids failed: {e}"))
            })?;
            let entries: Vec<(String, String)> = serde_json::from_str(&json).map_err(|e| {
                Error::new(Status::GenericFailure, format!("parse ids failed: {e}"))
            })?;
            entries
                .into_iter()
                .filter_map(|(k, v)| k.parse::<u64>().ok().map(|k| (k, v)))
                .collect()
        } else {
            HashMap::new()
        };

        Ok(Self {
            inner: Some(inner),
            id_map,
            dim,
            bit_width,
        })
    }

    /// Insert or replace a vector.  Upsert semantics: if `id` already exists
    /// the old vector is removed before inserting the new one.
    #[napi]
    pub fn add(&mut self, id: String, vector: Float32Array) -> Result<()> {
        let inner = self
            .inner
            .as_mut()
            .ok_or_else(|| Error::new(Status::GenericFailure, "index has been closed"))?;

        let data: &[f32] = vector.as_ref();
        if data.len() != self.dim {
            return Err(Error::new(
                Status::InvalidArg,
                format!("vector length {} != dim {}", data.len(), self.dim),
            ));
        }

        let hash = fnv1a_64(&id);

        // Remove the previous entry for this ID so turbovec sees a clean insert.
        if self.id_map.contains_key(&hash) {
            inner.remove(hash);
        }

        inner
            .add_with_ids_2d(data, self.dim, &[hash])
            .map_err(|e| Error::new(Status::InvalidArg, format!("{e:?}")))?;

        self.id_map.insert(hash, id);
        Ok(())
    }

    /// Remove a vector by string ID.  Returns `true` if found and removed.
    #[napi]
    pub fn remove(&mut self, id: String) -> bool {
        let hash = fnv1a_64(&id);
        if let Some(inner) = self.inner.as_mut() {
            if inner.remove(hash) {
                self.id_map.remove(&hash);
                return true;
            }
        }
        false
    }

    /// Search for the top-`k` nearest neighbours of `query`.
    ///
    /// Returns `[{ id, score }]` sorted by descending similarity.
    #[napi]
    pub fn search(&self, query: Float32Array, k: u32) -> Result<Vec<SearchResult>> {
        let inner = self
            .inner
            .as_ref()
            .ok_or_else(|| Error::new(Status::GenericFailure, "index has been closed"))?;

        let data: &[f32] = query.as_ref();
        if data.len() != self.dim {
            return Err(Error::new(
                Status::InvalidArg,
                format!("query length {} != dim {}", data.len(), self.dim),
            ));
        }

        let (scores, ids) = inner.search(data, k as usize);

        Ok(ids
            .into_iter()
            .zip(scores)
            .filter_map(|(hash, score)| {
                self.id_map.get(&hash).map(|id| SearchResult {
                    id: id.clone(),
                    score: score as f64,
                })
            })
            .collect())
    }

    /// Persist the index to `bin_path` (turbovec binary) and `bin_path + ".ids"` (JSON sidecar).
    #[napi]
    pub fn save(&self, bin_path: String) -> Result<()> {
        let inner = self
            .inner
            .as_ref()
            .ok_or_else(|| Error::new(Status::GenericFailure, "index has been closed"))?;

        inner
            .write(&bin_path)
            .map_err(|e| Error::new(Status::GenericFailure, format!("write failed: {e}")))?;

        // Serialize id_map as JSON array of [hash_string, id] pairs.
        let pairs: Vec<(String, &str)> = self
            .id_map
            .iter()
            .map(|(k, v)| (k.to_string(), v.as_str()))
            .collect();
        let json = serde_json::to_string(&pairs)
            .map_err(|e| Error::new(Status::GenericFailure, format!("serialize ids failed: {e}")))?;
        let ids_path = bin_path + ".ids";
        std::fs::write(&ids_path, json.as_bytes())
            .map_err(|e| Error::new(Status::GenericFailure, format!("write ids failed: {e}")))?;

        Ok(())
    }

    /// Number of vectors currently in the index.
    #[napi]
    pub fn len(&self) -> u32 {
        self.inner.as_ref().map_or(0, |i| i.len() as u32)
    }

    /// True when the index contains no vectors.
    #[napi]
    pub fn is_empty(&self) -> bool {
        self.inner.as_ref().map_or(true, |i| i.is_empty())
    }

    /// Embedding dimension this index was created with.
    #[napi]
    pub fn dim(&self) -> u32 {
        self.dim as u32
    }

    /// Bits per coordinate (2, 3, or 4).
    #[napi]
    pub fn bit_width(&self) -> u32 {
        self.bit_width as u32
    }

    /// All string IDs currently in the index.
    #[napi]
    pub fn get_ids(&self) -> Vec<String> {
        self.id_map.values().cloned().collect()
    }

    /// Eagerly warm up the SIMD caches.  Optional — improves first-search
    /// latency at the cost of a one-time setup when called.
    #[napi]
    pub fn prepare(&self) {
        if let Some(inner) = self.inner.as_ref() {
            inner.prepare();
        }
    }

    /// Release the inner index and free all memory.
    #[napi]
    pub fn close(&mut self) {
        self.inner = None;
        self.id_map.clear();
    }
}
