// Load in <head> so the page does not flash the wrong theme.
document.documentElement.dataset.theme = localStorage.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
function toggleTheme() {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = localStorage.theme = t;
  dispatchEvent(new Event('themechange'));
}
const theme = () => document.documentElement.dataset.theme;
