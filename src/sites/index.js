// Picks the first adapter whose host regex matches the current hostname.
(function () {
  const CM = (window.CM = window.CM || {});
  CM.pickAdapter = function pickAdapter(hostname) {
    const list = CM.adapters || [];
    for (const a of list) {
      if (a.host.test(hostname)) return a;
    }
    return null;
  };
})();
