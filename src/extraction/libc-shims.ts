/**
 * C library functions that some tree-sitter grammars import and the tree-sitter runtime does not
 * provide.
 *
 * A grammar module is linked at load time against the runtime's exports. The bash grammar imports
 * `isalpha`, and the yaml grammar imports the C++ operators `new` and `delete` plus `abort`; the
 * runtime in web-tree-sitter 0.25 exports none of them. The link is lazy, so the grammar loads and
 * then fails at the first parse with "resolved is not a function". Every file in those languages
 * failed on every index and sync.
 *
 * `loadWebAssemblyModule` accepts a local scope that is searched before it gives up on a symbol.
 * `shimLibc` wraps it to pass the functions below. They are plain JavaScript over the runtime's
 * own `malloc` and `free`, so they use the same heap as the grammar.
 */

type RuntimeModule = {
  _malloc: (size: number) => number;
  HEAPU8: Uint8Array;
  _free: (ptr: number) => void;
  loadWebAssemblyModule: (...args: any[]) => any;
};

/**
 * Name a grammar's `malloc` import is changed to, so that it is resolved through the scope
 * `shimLibc` passes rather than to the runtime's own function. Same length as "malloc".
 */
const ZEROED_MALLOC = 'zalloc';

/**
 * Makes the grammar's `malloc` return zeroed memory.
 *
 * The Lua scanner allocates its state with malloc and reads it before setting it. On a heap that
 * has never been used that is zeros; once memory has been freed and reused it is whatever was
 * there, and the parse then fails on comments (an ERROR tree, the first function of the file
 * lost). The second Lua file parsed in a process was the first affected, and which files were
 * depended on what had been parsed before them.
 *
 * The runtime binds a grammar's `malloc` to its own before the scope is consulted, so it cannot
 * be replaced from outside. The import is renamed in the module's binary instead (to a name of
 * the same length, so no offset changes), and the new name is provided by `shimLibc`. Only the
 * import section is touched. A binary that does not parse as expected is returned unchanged.
 */
export function zeroMallocInBinary(binary: Uint8Array): Uint8Array {
  let pos = 8; // magic and version
  const leb = (): number => {
    let result = 0, shift = 0, byte: number;
    do { byte = binary[pos++]; result += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
    return result;
  };
  const limits = () => { const flags = leb(); leb(); if (flags & 1) leb(); };
  try {
    while (pos < binary.length) {
      const id = binary[pos++];
      const size = leb();
      const end = pos + size;
      if (id !== 2) { pos = end; continue; }
      const patched = Uint8Array.from(binary);
      for (let count = leb(); count > 0; count--) {
        const moduleLen = leb();
        pos += moduleLen; // module name
        const nameLen = leb();
        const nameAt = pos;
        pos += nameLen;
        if (nameLen === 6 && String.fromCharCode(...binary.subarray(nameAt, nameAt + 6)) === 'malloc') {
          for (let i = 0; i < 6; i++) patched[nameAt + i] = ZEROED_MALLOC.charCodeAt(i);
        }
        const kind = binary[pos++];
        if (kind === 0) leb();                    // function: type index
        else if (kind === 1) { pos++; limits(); } // table: reference type, limits
        else if (kind === 2) limits();            // memory
        else if (kind === 3) pos += 2;            // global: value type, mutability
        else if (kind === 4) { pos++; leb(); }    // tag: attribute, type index
        else return binary;
      }
      return pos === end ? patched : binary;
    }
  } catch { /* fall through */ }
  return binary;
}

/** The symbols a grammar may need, keyed by the name it imports. */
function libcShims(mod: RuntimeModule): Record<string, (...args: any[]) => any> {
  return {
    // ctype: the C locale, ASCII letters only
    isalpha: (c: number) => ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? 1 : 0),
    // malloc that returns zeroed memory: see zeroedMalloc
    [ZEROED_MALLOC]: (size: number) => {
      const ptr = mod._malloc(size);
      if (ptr) mod.HEAPU8.fill(0, ptr, ptr + size);
      return ptr;
    },
    // operator new / delete, scalar and array forms
    _Znwm: (size: number) => mod._malloc(size),
    _Znam: (size: number) => mod._malloc(size),
    _ZdlPv: (ptr: number) => mod._free(ptr),
    _ZdaPv: (ptr: number) => mod._free(ptr),
    abort: () => { throw new Error('abort() called by a tree-sitter grammar'); },
    // std::vector length error thrown by a grammar's C++ scanner
    _ZNKSt3__220__vector_base_commonILb1EE20__throw_length_errorEv: () => {
      throw new RangeError('vector length error in a tree-sitter grammar');
    },
  };
}

/**
 * Makes grammars load with the symbols above available. `mod` is the object that was passed to
 * `Parser.init`, which web-tree-sitter uses as its runtime module.
 */
export function shimLibc(mod: RuntimeModule): void {
  const shims = libcShims(mod);
  const link = mod.loadWebAssemblyModule;
  mod.loadWebAssemblyModule = (binary: unknown, flags: unknown, libName: unknown, localScope: unknown, handle: unknown) =>
    link(binary, flags, libName, { ...shims, ...(localScope as object | undefined) }, handle);
}
