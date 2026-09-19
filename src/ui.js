import './ui.css';
import { buildPauseMenu } from './menuModel.js';

// The flat-screen shell: a retro start menu, a one-line status bar, and a
// settings screen built from the shared menu model.
//
// None of this exists inside a headset — the immersive session only renders
// the 3D scene — so the same menu model is drawn again in world space by
// vrMenu.js. This file is what you use before putting the headset on, and
// what the on-screen preview runs on.

export class UI {
  // `isInputBlocked` lets the caller veto keyboard commands — the in-headset
  // menu uses it so a keypress can't drive the game from behind an open
  // pause screen.
  constructor({ xr, machine, game, settings, sfx, onStart, onExit, isInputBlocked }) {
    Object.assign(this, { xr, machine, game, settings, sfx, onStart, onExit });
    this.isInputBlocked = isInputBlocked ?? (() => false);

    this._selected = 0;
    this._entries = [];
    this._toastTimer = null;
    this._lastRevision = -1;

    this._buildMenu();
    this._buildBar();
    this._buildSettings();
    this._buildToast();

    window.addEventListener('keydown', (e) => this._onKey(e));
    this.showMenu();
  }

  // --- Start menu -------------------------------------------------------

  _buildMenu() {
    const el = document.createElement('div');
    el.id = 'menu';
    el.innerHTML = `
      <div>
        <h1 class="title">Ping<span>·</span>Pong<br />Trainer<span class="blink">_</span></h1>
        <p class="tagline">Hack the North 2026</p>
      </div>
      <div class="menu-list" data-list></div>
      <div class="hint">
        ↑ ↓ select &nbsp;·&nbsp; enter start<br />
        <span data-menu-note></span>
      </div>
    `;
    document.body.appendChild(el);
    this.menu = el;
    this.list = el.querySelector('[data-list]');

    this._entries = [
      { id: 'ar', label: 'Enter passthrough', note: '', disabled: true },
      { id: 'vr', label: 'Enter full VR', note: '', disabled: true },
      { id: 'desktop', label: 'Computer', note: 'preview', disabled: false },
    ];
    this._renderMenu();
  }

  _renderMenu() {
    this.list.innerHTML = '';
    this._entries.forEach((entry, i) => {
      const b = document.createElement('button');
      b.className = 'item';
      b.disabled = entry.disabled;
      b.setAttribute('aria-selected', String(i === this._selected));
      b.innerHTML =
        `<span class="item__caret">▸</span><span>${entry.label}</span>` +
        (entry.note ? `<span class="item__note">${entry.note}</span>` : '');
      b.onmouseenter = () => {
        this._selected = i;
        this._syncMenuSelection();
      };
      b.onclick = () => this._activateMenu(i);
      this.list.appendChild(b);
    });
  }

  _syncMenuSelection() {
    [...this.list.children].forEach((child, i) =>
      child.setAttribute('aria-selected', String(i === this._selected))
    );
  }

  _moveMenu(delta) {
    const n = this._entries.length;
    let next = this._selected;
    // Skip over unavailable entries so the caret never parks on a dead line
    for (let i = 0; i < n; i++) {
      next = (next + delta + n) % n;
      if (!this._entries[next].disabled) break;
    }
    this._selected = next;
    this._syncMenuSelection();
    this.sfx.ui();
  }

  _activateMenu(index) {
    const entry = this._entries[index];
    if (!entry || entry.disabled) return;
    if (entry.id === 'desktop') this._launch(null);
    else this._launch(entry.id === 'ar' ? 'immersive-ar' : 'immersive-vr');
  }

  applyXRSupport(support) {
    this._entries[0].disabled = !support['immersive-ar'];
    this._entries[1].disabled = !support['immersive-vr'];
    this._entries[0].note = support['immersive-ar'] ? '' : 'unavailable';
    this._entries[1].note = support['immersive-vr'] ? '' : 'unavailable';

    const note = this.menu.querySelector('[data-menu-note]');
    note.textContent = support['immersive-ar'] || support['immersive-vr']
      ? 'Headset ready'
      : 'No headset — open in the Meta Quest Browser for VR';

    this._selected = this._entries.findIndex((e) => !e.disabled);
    if (this._selected < 0) this._selected = 0;
    this._renderMenu();
  }

  async _launch(mode) {
    this.sfx.unlock(); // first user gesture — the only moment audio can start
    this.sfx.ui();
    this.menu.hidden = true;
    this.bar.hidden = false;
    this.onStart?.(mode);

    if (mode) {
      try {
        await this.xr.start(mode);
      } catch (err) {
        console.error('Failed to start XR session', err);
        this.toast('Headset session failed');
        this.showMenu();
      }
    }
  }

  showMenu() {
    this.menu.hidden = false;
    if (this.bar) this.bar.hidden = true;
    if (this.settingsEl) this.settingsEl.hidden = true;
  }

  // --- Bottom status line ----------------------------------------------

  _buildBar() {
    const el = document.createElement('div');
    el.id = 'bar';
    el.innerHTML = `
      <span class="bar__mode" data-bar-mode>—</span>
      <span class="bar__stats" data-bar-stats>—</span>
      <span class="bar__spacer"></span>
      <button class="key" data-act="toggle"><b>Space</b><span data-toggle-label>Pause</span></button>
      <button class="key" data-act="mode"><b>D</b>Mode</button>
      <button class="key" data-act="serve"><b>S</b>Serve</button>
      <button class="key" data-act="settings"><b>Tab</b>Settings</button>
      <button class="key" data-act="exit"><b>Esc</b>Menu</button>
    `;
    document.body.appendChild(el);
    this.bar = el;

    el.querySelector('[data-act="toggle"]').onclick = () => this.togglePause();
    el.querySelector('[data-act="mode"]').onclick = () => this.nextMode();
    el.querySelector('[data-act="serve"]').onclick = () => this.machine.serve();
    el.querySelector('[data-act="settings"]').onclick = () => this.toggleSettings();
    el.querySelector('[data-act="exit"]').onclick = () => this.quitToMenu();
  }

  // --- Settings ---------------------------------------------------------

  _buildSettings() {
    const el = document.createElement('div');
    el.id = 'settings';
    el.hidden = true;
    el.innerHTML = `
      <div class="settings__title">Settings</div>
      <div class="settings__list" data-rows></div>
      <div class="hint">Tab / Esc to close</div>
    `;
    document.body.appendChild(el);
    this.settingsEl = el;
    this.rows = el.querySelector('[data-rows]');
  }

  _renderSettings() {
    const items = this._menuItems().filter(
      (i) => i.kind !== 'action' || i.id === 'reset'
    );
    this.rows.innerHTML = '';

    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'row';

      if (item.kind === 'action') {
        row.innerHTML = `<button class="key"><b>▸</b>${item.label}</button><span></span>`;
        row.querySelector('button').onclick = () => {
          item.activate();
          this.sfx.ui();
          this.toast(item.label);
        };
      } else {
        row.innerHTML = `
          <span class="row__label">${item.label}</span>
          <span class="row__value">
            <button class="arrow" data-d="-1">‹</button>
            <span class="row__current">${item.value}</span>
            <button class="arrow" data-d="1">›</button>
          </span>
        `;
        row.querySelectorAll('.arrow').forEach((b) => {
          b.onclick = () => {
            item.step(Number(b.dataset.d));
            this.sfx.ui();
            this._renderSettings();
          };
        });
      }
      this.rows.appendChild(row);
    }
  }

  _menuItems() {
    return buildPauseMenu({
      machine: this.machine,
      game: this.game,
      settings: this.settings,
      onResume: () => this.toggleSettings(false),
      onExit: () => this.quitToMenu(),
    });
  }

  // --- Commands (shared by clicks, keys and the VR menu) ----------------

  togglePause() {
    this.machine.enabled = !this.machine.enabled;
    this.game.revision++;
    this.sfx.ui(this.machine.enabled);
    this.toast(this.machine.enabled ? 'Armed' : 'Paused');
  }

  nextMode() {
    const mode = this.machine.nextDrill();
    this.game.revision++;
    this.sfx.ui();
    this.toast(mode.name);
  }

  toggleSettings(force) {
    const open = force ?? this.settingsEl.hidden;
    this.settingsEl.hidden = !open;
    if (open) this._renderSettings();
    this.sfx.ui(open);
  }

  quitToMenu() {
    this.settingsEl.hidden = true;
    this.xr.end();
    this.onExit?.();
    this.showMenu();
  }

  // --- Keyboard ---------------------------------------------------------

  _onKey(e) {
    if (!this.menu.hidden) {
      if (e.code === 'ArrowUp') this._moveMenu(-1);
      else if (e.code === 'ArrowDown') this._moveMenu(1);
      else if (e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        this._activateMenu(this._selected);
      }
      return;
    }

    if (this.isInputBlocked()) return; // the in-headset menu has the floor

    if (e.code === 'Escape') {
      if (!this.settingsEl.hidden) this.toggleSettings(false);
      else this.quitToMenu();
    } else if (e.code === 'Tab') {
      e.preventDefault();
      this.toggleSettings();
    } else if (e.code === 'Space') {
      e.preventDefault();
      this.togglePause();
    } else if (e.code === 'KeyD') {
      this.nextMode();
    } else if (e.code === 'KeyS') {
      this.machine.serve();
    } else if (e.code === 'KeyR') {
      this.game.reset();
      this.toast('Score reset');
    }
  }

  // --- Toast ------------------------------------------------------------

  _buildToast() {
    this.toastEl = document.createElement('div');
    this.toastEl.id = 'toast';
    document.body.appendChild(this.toastEl);
  }

  toast(message) {
    this.toastEl.textContent = message;
    this.toastEl.classList.add('is-visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(
      () => this.toastEl.classList.remove('is-visible'),
      1300
    );
  }

  // --- Per-frame sync ---------------------------------------------------

  update() {
    if (this.game.revision === this._lastRevision) return;
    this._lastRevision = this.game.revision;

    const { game, machine } = this;
    this.bar.querySelector('[data-bar-mode]').textContent = machine.mode.name;
    this.bar.querySelector('[data-bar-stats]').textContent = machine.isTargetMode
      ? `${game.targetsHit} targets · ${game.returns} on table`
      : `streak ${game.streak} · ${game.returns}/${game.hits + game.misses} on table`;
    this.bar.querySelector('[data-toggle-label]').textContent = machine.enabled
      ? 'Pause'
      : 'Arm';
  }
}
