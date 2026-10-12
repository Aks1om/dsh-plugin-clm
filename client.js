window.__ModuleLoader__.load({
  id: "@local/dsh-plugin-clm",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    exports.apply = function apply(ctx) {
      // Cliente complementario de CLM cargado
    };
    exports.inject = ["slots"];
    return module.exports;
  }
});
