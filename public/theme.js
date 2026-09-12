// Runs before the stylesheet and React, including under the production CSP.
(() => {
  let theme = "system";
  try {
    const saved = localStorage.getItem("braindump.theme");
    if (saved === "light" || saved === "dark" || saved === "system") {
      theme = saved;
    } else if (saved !== null) {
      localStorage.removeItem("braindump.theme");
    }
  } catch {
    // Private browsing or blocked storage still permits a system-based theme.
  }
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.remove("light", "dark");
  document.documentElement.classList.add(dark ? "dark" : "light");
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
})();
