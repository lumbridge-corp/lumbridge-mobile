// Runs before the first paint, so a chosen theme never flashes the other one. theme.ts owns the choice; this only reads it.
(function () {
  var t = null;
  try { t = localStorage.getItem("__STORAGE_NS__.theme"); } catch (e) { /* storage blocked: follow the system */ }
  if (t !== "dark" && t !== "light") return;
  document.documentElement.setAttribute("data-theme", t);
  var c = t === "dark" ? "#0a0a0a" : "#ffffff";
  var m = document.querySelectorAll('meta[name="theme-color"]');
  for (var i = 0; i < m.length; i++) m[i].setAttribute("content", c);
})();
