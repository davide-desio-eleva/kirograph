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
  _free: (ptr: number) => void;
  loadWebAssemblyModule: (...args: any[]) => any;
};

/** The symbols a grammar may need, keyed by the name it imports. */
function libcShims(mod: RuntimeModule): Record<string, (...args: any[]) => any> {
  return {
    // ctype: the C locale, ASCII letters only
    isalpha: (c: number) => ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? 1 : 0),
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
