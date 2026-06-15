// ============================================================
// PackPrice · Custom dropdown (renderer)
// ============================================================
// Progressive enhancement over the native <select>: the native element
// stays in the DOM as the source of truth (kept, just visually hidden)
// and a styled button + listbox panel is layered on top. Picking an
// option writes select.value and dispatches a native 'change' (bubbling),
// so every existing binding keeps working untouched:
//   - data-cfg-path / data-action-change change listeners (admin)
//   - the data-linea-modelo change delegated on #paso2
//   - the cloud-account picker (reads .value)
//
// Why enhance instead of replacing: the native <select> popup is OS-drawn
// and unstyleable, which breaks the modern UI; but its value/change
// contract is exactly what the rest of the renderer already speaks. We
// keep the contract, we restyle the surface. No deps, no build, no assets
// (caret + check are inline SVG). UI strings stay Spanish; code English.
// ============================================================

let uid = 0;
let openInstance = null; // the dropdown whose panel is currently open
let globalsBound = false;

const CARET_SVG =
  "<svg class=\"pp-select__caret\" width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" " +
  "fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" " +
  "stroke-linejoin=\"round\"><polyline points=\"6 9 12 15 18 9\"/></svg>";

/** Enhances every native <select> under `root` (idempotent). */
export function enhanceDropdowns(root = document) {
  bindGlobals();
  const scope = root && root.querySelectorAll ? root : document;
  scope
    .querySelectorAll('select:not([data-pp-enhanced]):not([data-no-dropdown])')
    .forEach(enhanceSelect);
}

function bindGlobals() {
  if (globalsBound) return;
  globalsBound = true;
  // Outside click closes the open panel. Clicks inside the wrapper
  // (trigger/options) are handled by the instance itself.
  document.addEventListener('click', (e) => {
    if (openInstance && !openInstance.wrapper.contains(e.target)) {
      openInstance.close();
    }
  });
}

function enhanceSelect(select) {
  if (select.dataset.ppEnhanced === '1') return;
  if (select.multiple) return; // native fallback for multi-select
  select.dataset.ppEnhanced = '1';

  const baseId = `pp-dd-${++uid}`;

  const wrapper = document.createElement('div');
  wrapper.className = 'pp-select';
  select.parentNode.insertBefore(wrapper, select);
  wrapper.appendChild(select);
  select.classList.add('pp-select__native');
  select.setAttribute('tabindex', '-1');
  select.setAttribute('aria-hidden', 'true');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'pp-select__trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = `<span class="pp-select__label"></span>${CARET_SVG}`;
  const label = trigger.querySelector('.pp-select__label');

  const panel = document.createElement('div');
  panel.className = 'pp-select__panel';
  panel.id = `${baseId}-panel`;
  panel.setAttribute('role', 'listbox');
  panel.hidden = true;
  trigger.setAttribute('aria-controls', panel.id);

  wrapper.appendChild(trigger);
  wrapper.appendChild(panel);

  let optionEls = [];
  let activeIndex = -1;
  let typeBuffer = '';
  let typeTimer = null;

  const instance = { wrapper, trigger, panel, close };

  // --- rendering -------------------------------------------------

  function rebuild() {
    panel.innerHTML = '';
    optionEls = Array.from(select.options).map((opt, i) => {
      const row = document.createElement('div');
      row.className = 'pp-select__option';
      row.setAttribute('role', 'option');
      row.id = `${baseId}-opt-${i}`;
      row.textContent = opt.textContent;
      if (opt.disabled) row.setAttribute('aria-disabled', 'true');
      row.addEventListener('click', () => { if (!opt.disabled) commit(i); });
      panel.appendChild(row);
      return row;
    });
    reflectSelection();
    trigger.disabled = select.disabled;
  }

  function reflectSelection() {
    const sIdx = select.selectedIndex;
    optionEls.forEach((row, i) => {
      const on = i === sIdx;
      row.classList.toggle('is-selected', on);
      if (on) row.setAttribute('aria-selected', 'true');
      else row.removeAttribute('aria-selected');
    });
    label.textContent = sIdx >= 0 ? select.options[sIdx].textContent : '';
  }

  function highlight(i, scroll = true) {
    if (i < 0 || i >= optionEls.length) return;
    activeIndex = i;
    optionEls.forEach((row, idx) => row.classList.toggle('is-active', idx === i));
    trigger.setAttribute('aria-activedescendant', optionEls[i].id);
    if (scroll) optionEls[i].scrollIntoView({ block: 'nearest' });
  }

  // --- selection -------------------------------------------------

  function commit(i) {
    if (!select.options[i]) return;
    if (select.selectedIndex !== i) {
      select.selectedIndex = i;
      // A 'change' may trigger a full re-render that discards this DOM
      // (e.g. admin pricing-mode). Re-enhancement rebuilds it afresh.
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (wrapper.isConnected) {
      reflectSelection();
      close();
      trigger.focus();
    }
  }

  // --- open / close ----------------------------------------------

  function open() {
    if (trigger.disabled) return;
    if (openInstance && openInstance !== instance) openInstance.close();
    rebuild(); // pick up any option changes since last open
    panel.hidden = false;
    wrapper.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    placePanel();
    openInstance = instance;
    highlight(select.selectedIndex >= 0 ? select.selectedIndex : firstEnabled(), false);
  }

  function close() {
    panel.hidden = true;
    wrapper.classList.remove('is-open', 'pp-select--up');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    if (openInstance === instance) openInstance = null;
  }

  function placePanel() {
    wrapper.classList.remove('pp-select--up');
    const rect = trigger.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    const needed = Math.min(panel.scrollHeight + 12, 292);
    if (below < needed && rect.top > below) wrapper.classList.add('pp-select--up');
  }

  // --- keyboard --------------------------------------------------

  function firstEnabled() {
    for (let i = 0; i < select.options.length; i++) {
      if (!select.options[i].disabled) return i;
    }
    return 0;
  }

  function lastEnabled() {
    for (let i = select.options.length - 1; i >= 0; i--) {
      if (!select.options[i].disabled) return i;
    }
    return select.options.length - 1;
  }

  function moveActive(dir) {
    const n = optionEls.length;
    if (!n) return;
    let i = activeIndex < 0 ? (dir > 0 ? -1 : 0) : activeIndex;
    for (let step = 0; step < n; step++) {
      i = (i + dir + n) % n;
      if (!select.options[i].disabled) { highlight(i); return; }
    }
  }

  function typeahead(ch) {
    typeBuffer += ch.toLowerCase();
    clearTimeout(typeTimer);
    typeTimer = setTimeout(() => { typeBuffer = ''; }, 600);
    const start = activeIndex < 0 ? -1 : activeIndex;
    for (let k = 1; k <= optionEls.length; k++) {
      const i = (start + k) % optionEls.length;
      const opt = select.options[i];
      if (!opt.disabled && opt.textContent.toLowerCase().startsWith(typeBuffer)) {
        highlight(i);
        return;
      }
    }
  }

  trigger.addEventListener('click', () => {
    if (panel.hidden) open(); else close();
  });

  trigger.addEventListener('keydown', (e) => {
    const isOpen = !panel.hidden;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        isOpen ? moveActive(1) : open();
        break;
      case 'ArrowUp':
        e.preventDefault();
        isOpen ? moveActive(-1) : open();
        break;
      case 'Home':
        if (isOpen) { e.preventDefault(); highlight(firstEnabled()); }
        break;
      case 'End':
        if (isOpen) { e.preventDefault(); highlight(lastEnabled()); }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (!isOpen) open();
        else if (activeIndex >= 0) commit(activeIndex);
        break;
      case 'Escape':
        if (isOpen) { e.preventDefault(); e.stopPropagation(); close(); }
        break;
      case 'Tab':
        if (isOpen) close();
        break;
      default:
        if (isOpen && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          typeahead(e.key);
        }
        break;
    }
  });

  rebuild();
}
