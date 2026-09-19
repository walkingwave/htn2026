import './ui.css';
import { buildPauseMenu } from './menuModel.js';
import { createTournament, reportResult, currentMatches, isComplete, renderBracketLines } from './tournament.js';
import { OPTIONS } from './settings.js';
import { MODES } from './ballMachine.js';

// Play-a-Bot settings step. Each row cycles through a short list; the labels
// are the source of truth passed to main via choice.botSettings, which maps
// them back onto Settings values / machine.modeIndex.
const BOT_SETTING_ROWS = [
  { id: 'pace', label: 'Ball pace', options: OPTIONS.pace.map((o) => o.label) },
  { id: 'feedRate', label: 'Feed rate', options: OPTIONS.feedRate.map((o) => o.label) },
  { id: 'placement', label: 'Placement', options: OPTIONS.placement.map((o) => o.label) },
  {
    id: 'shot',
    label: 'Shot type',
    // The playable drill/rally shots — everything the machine can launch
    // except the target-practice feed (that's the Drills mode).
    options: MODES.filter((m) => m.type !== 'target').map((m) => m.name),
  },
];

// Escape user-supplied text (player names) before it goes into innerHTML.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The flat-screen shell: a retro start menu, a one-line status bar, and a
// settings screen built from the shared menu model.
//
// None of this exists inside a headset — the immersive session only renders
// the 3D scene — so the same menu model is drawn again in world space by
// vrMenu.js. This file is what you use before putting the headset on, and
// what the on-screen preview runs on.

export class UI {
  constructor({ xr, machine, game, settings, sfx, onStart, onExit, onVersusCreate, onVersusJoin, onVersusLeave, onTourneyCreate, onTourneyJoin, onTourneySend, onTourneyLeave }) {
    Object.assign(this, {
      xr, machine, game, settings, sfx, onStart, onExit,
      onVersusCreate, onVersusJoin, onVersusLeave,
      onTourneyCreate, onTourneyJoin, onTourneySend, onTourneyLeave,
    });

    this._selected = 0;
    this._entries = [];
    this._toastTimer = null;
    this._lastRevision = -1;

    this._buildMenu();
    this._buildBar();
    this._buildSettings();
    this._buildToast();
    this._buildCountdown();
    this._buildTournament();
    this._buildVersus();
    this._versusRole = 'host';

    window.addEventListener('keydown', (e) => this._onKey(e));
    this.showMenu();
  }

  // --- Start menu -------------------------------------------------------

  _buildMenu() {
    const el = document.createElement('div');
    el.id = 'menu';
    el.innerHTML = `
      <div>
        <h1 class="title">Fly<span>·</span>Ball<span class="blink">_</span></h1>
        <p class="tagline" data-prompt>Select a mode</p>
      </div>
      <div class="menu-list" data-list></div>
      <div class="hint">
        ↑ ↓ select &nbsp;·&nbsp; enter continue &nbsp;·&nbsp; esc back<br />
        <span data-menu-note></span>
      </div>
    `;
    document.body.appendChild(el);
    this.menu = el;
    this.list = el.querySelector('[data-list]');
    this.prompt = el.querySelector('[data-prompt]');
    this.note = el.querySelector('[data-menu-note]');

    this._xrSupport = { 'immersive-ar': false, 'immersive-vr': false };
    this._flow = { step: 'mode', mode: null, input: null, background: null };
    // Default Play-a-Bot config: Normal pace/feed/placement, roaming Infinite
    // shot. Stored as an index into each row's option list.
    this._botSel = { pace: 1, feedRate: 1, placement: 1, shot: BOT_SETTING_ROWS[3].options.indexOf('Infinite') };
    if (this._botSel.shot < 0) this._botSel.shot = 0;
    this._gotoStep('mode');
  }

  // Each wizard step is just a fresh set of menu entries + a prompt. The
  // shared renderer/keyboard nav below don't care which step is showing.
  _stepConfig(step) {
    if (step === 'mode') {
      return {
        prompt: 'Select a mode',
        note: 'What do you want to play?',
        entries: [
          { id: 'tournament', label: 'Create a Tournament', note: 'beta' },
          { id: 'friend', label: 'Play a Friend', note: 'beta' },
          { id: 'bot', label: 'Play a Bot' },
          { id: 'drills', label: 'Drills' },
        ],
      };
    }
    if (step === 'input') {
      const vrOk = this._xrSupport['immersive-vr'] || this._xrSupport['immersive-ar'];
      return {
        prompt: 'What do you have?',
        note: 'Choose how you control the paddle',
        entries: [
          { id: 'vr', label: 'A VR Headset', note: vrOk ? '' : 'no headset', disabled: !vrOk },
          { id: 'paddle', label: 'A Ping Pong Paddle', note: 'webcam' },
          { id: 'phone', label: 'A Phone', note: 'beta' },
          { id: 'mouse', label: 'Nothing — just the mouse' },
        ],
      };
    }
    if (step === 'background') {
      return {
        prompt: 'Choose your court',
        note: 'Set the scene, then play',
        entries: [
          { id: 'arena', label: 'Charcoal Arena' },
          { id: 'sunset', label: 'Sunset Court' },
          { id: 'neon', label: 'Neon Night' },
          { id: 'void', label: 'Blackout' },
        ],
      };
    }
    // Drills only: tune how the ball machine feeds before launching. Each row
    // shows its current value and cycles on select; a final row starts the
    // drill. Uses the same .item/caret rows as every other step.
    const rows = BOT_SETTING_ROWS.map((row) => ({
      id: row.id,
      label: row.label,
      note: row.options[this._botSel[row.id]],
    }));
    rows.push({ id: 'launch', label: 'Start drills', note: '▸ play' });
    return {
      prompt: 'Set up your drill',
      note: '← → change · enter cycles · Start drills to play',
      entries: rows,
    };
  }

  _gotoStep(step) {
    this._flow.step = step;
    const cfg = this._stepConfig(step);
    this._entries = cfg.entries;
    if (this.prompt) this.prompt.textContent = cfg.prompt;
    if (this.note) this.note.textContent = cfg.note;
    this._selected = this._entries.findIndex((e) => !e.disabled);
    if (this._selected < 0) this._selected = 0;
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

  async _activateMenu(index) {
    const entry = this._entries[index];
    if (!entry || entry.disabled) return;
    this.sfx.ui();
    const step = this._flow.step;
    if (step === 'mode') {
      if (entry.id === 'tournament') { this.openTournament(); return; }
      if (entry.id === 'friend') {
        const info = await this.onVersusCreate?.();
        if (info) this.openVersusLobby(info);
        return;
      }
      this._flow.mode = entry.id;
      this._gotoStep('input');
    } else if (step === 'input') {
      this._flow.input = entry.id;
      this._gotoStep('background');
    } else if (step === 'background') {
      this._flow.background = entry.id;
      // Drills get a ball-machine settings step; every other mode (including
      // Play a Bot) launches straight away.
      if (this._flow.mode === 'drills') this._gotoStep('settings');
      else this._launchFlow();
    } else {
      // Settings step: choice rows cycle their value; the launch row plays.
      if (entry.id === 'launch') this._launchFlow();
      else this._cycleSetting(entry.id, 1);
    }
  }

  // Advance (or rewind) one bot-setting row through its option list, wrapping,
  // then re-render in place so the caret stays put.
  _cycleSetting(id, delta) {
    const row = BOT_SETTING_ROWS.find((r) => r.id === id);
    if (!row) return;
    const n = row.options.length;
    this._botSel[id] = (this._botSel[id] + delta + n) % n;
    const keep = this._selected;
    this._gotoStep('settings');
    this._selected = keep;
    this._syncMenuSelection();
    this.sfx.ui();
  }

  _stepBack() {
    const step = this._flow.step;
    if (step === 'input') this._gotoStep('mode');
    else if (step === 'background') this._gotoStep('input');
    else if (step === 'settings') this._gotoStep('background');
    else return;
    this.sfx.ui();
  }

  applyXRSupport(support) {
    this._xrSupport = support;
    const anyXR = support['immersive-ar'] || support['immersive-vr'];
    // Refresh whichever step is showing so the VR line enables/greys out.
    if (this.menu && !this.menu.hidden) {
      if (this._flow.step === 'input') this._gotoStep('input');
      else if (this._flow.step === 'mode' && this.note) {
        this.note.textContent = anyXR ? 'Headset ready · pick a mode' : 'What do you want to play?';
      }
    }
  }

  async _launchFlow() {
    const { mode, input, background } = this._flow;
    // A VR headset starts an immersive session (his XR path); every other
    // input runs the on-screen desktop/pointer build.
    const xrMode = input === 'vr'
      ? (this._xrSupport['immersive-vr'] ? 'immersive-vr' : 'immersive-ar')
      : null;

    this.sfx.unlock(); // first user gesture — the only moment audio can start
    this.sfx.ui();
    this.menu.hidden = true;
    this.bar.hidden = false;

    // Only Drills carry a tuned ball-machine config; other modes launch as-is.
    const botSettings = mode === 'drills'
      ? {
          pace: BOT_SETTING_ROWS[0].options[this._botSel.pace],
          feedRate: BOT_SETTING_ROWS[1].options[this._botSel.feedRate],
          placement: BOT_SETTING_ROWS[2].options[this._botSel.placement],
          modeName: BOT_SETTING_ROWS[3].options[this._botSel.shot],
        }
      : null;

    this.onStart?.({ mode, input, background, xrMode, botSettings });

    if (xrMode) {
      try {
        await this.xr.start(xrMode);
      } catch (err) {
        console.error('Failed to start XR session', err);
        this.toast('Headset session failed');
        this.showMenu();
      }
    }
  }

  showMenu() {
    // If a tournament lobby is still open when we bail to the menu, tear down
    // its room so we don't leak the channel.
    if (this._tourney) { this.onTourneyLeave?.(); this._tourney = null; }
    this.menu.hidden = false;
    if (this.bar) this.bar.hidden = true;
    if (this.settingsEl) this.settingsEl.hidden = true;
    if (this.tournamentEl) this.tournamentEl.hidden = true;
    if (this.versusEl) this.versusEl.hidden = true;
    if (this.versusWinEl) this.versusWinEl.hidden = true;
    this.hideCountdown?.();
    this._gotoStep?.('mode');
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
    if (this.versusEl && !this.versusEl.hidden) {
      if (e.code === 'Escape') { this.onVersusLeave?.(); this.closeVersus(); }
      return;
    }
    if (this.tournamentEl && !this.tournamentEl.hidden) {
      if (e.code === 'Escape') { this.closeTournament(); }
      return;
    }
    if (!this.menu.hidden) {
      const inSettings = this._flow.step === 'settings';
      const sel = this._entries[this._selected];
      const onChoiceRow = inSettings && sel && sel.id !== 'launch';
      if (e.code === 'ArrowUp') this._moveMenu(-1);
      else if (e.code === 'ArrowDown') this._moveMenu(1);
      else if (e.code === 'ArrowLeft') {
        if (onChoiceRow) this._cycleSetting(sel.id, -1);
        else this._stepBack();
      }
      else if (e.code === 'ArrowRight') {
        if (onChoiceRow) this._cycleSetting(sel.id, 1);
      }
      else if (e.code === 'Escape') this._stepBack();
      else if (e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        this._activateMenu(this._selected);
      }
      return;
    }

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

  // --- Countdown (before the first ball) --------------------------------

  _buildCountdown() {
    // Full-screen dimming overlay that centres a single big numeral. The
    // numeral lives in its own element so the pop animation only scales the
    // digit chip, not the backdrop.
    this.countdownEl = document.createElement('div');
    this.countdownEl.id = 'countdown';
    this.countdownEl.hidden = true;
    this.countdownNum = document.createElement('span');
    this.countdownNum.className = 'countdown-num';
    this.countdownEl.appendChild(this.countdownNum);
    document.body.appendChild(this.countdownEl);
  }

  showCountdown(n) {
    if (!this.countdownEl) return;
    // Visibility is driven by a class so it never depends on the fragile
    // `hidden` attribute vs `display` specificity dance; the attribute is
    // cleared too so a stale [hidden] rule can never keep it off-screen.
    this.countdownEl.hidden = false;
    this.countdownEl.classList.add('is-visible');
    this.countdownNum.textContent = n;
    // Retrigger the pop animation on each number.
    this.countdownNum.classList.remove('pop');
    void this.countdownNum.offsetWidth;
    this.countdownNum.classList.add('pop');
    this.sfx?.ui?.();
  }

  hideCountdown() {
    if (!this.countdownEl) return;
    this.countdownEl.classList.remove('is-visible');
    this.countdownEl.hidden = true;
    this.countdownNum.classList.remove('pop');
  }

  // --- Tournament -------------------------------------------------------

  _buildTournament() {
    const el = document.createElement('div');
    el.id = 'tournament';
    el.hidden = true;
    el.innerHTML = `
      <div class="tourney-head">
        <h1 class="title">Tournament<span class="blink">_</span></h1>
        <p class="tagline" data-tourney-sub>Single elimination · first to 11, win by 2</p>
      </div>
      <div class="tourney-body" data-tourney-body></div>
      <div class="hint">click a name to advance them &nbsp;·&nbsp; esc menu</div>
    `;
    document.body.appendChild(el);
    this.tournamentEl = el;
    this.tourneyBody = el.querySelector('[data-tourney-body]');
    this.tourneySub = el.querySelector('[data-tourney-sub]');
  }

  openTournament() {
    // Host path: open a lobby room, then show the join code + live roster.
    this._tourneyMyId = this._tourneyMyId || 'p' + Math.random().toString(36).slice(2, 8);
    this._tourney = { role: 'host', code: '------', link: '', kind: 'local', roster: [], bracket: null };
    this.menu.hidden = true;
    if (this.bar) this.bar.hidden = true;
    this.tournamentEl.hidden = false;
    this.tourneySub.textContent = 'Opening lobby…';
    this.tourneyBody.innerHTML = '<p class="tourney-prompt">Creating lobby…</p>';
    Promise.resolve(this.onTourneyCreate?.())
      .then((info) => {
        if (!info) { this.tourneyBody.innerHTML = '<p class="tourney-prompt">Could not create a lobby.</p>'; return; }
        Object.assign(this._tourney, { code: info.code, link: info.link, kind: info.kind });
        this._tourney.roster = [{ id: this._tourneyMyId, name: 'Host', host: true }];
        this._renderTourneyLobby();
      })
      .catch((e) => { this.tourneyBody.innerHTML = `<p class="tourney-prompt">Lobby error: ${esc(e.message)}</p>`; });
  }

  // Guest path: reached from a shared ?t= link (main calls this on load).
  openTournamentJoin(code) {
    this._tourneyMyId = this._tourneyMyId || 'p' + Math.random().toString(36).slice(2, 8);
    this._tourney = { role: 'guest', code, roster: [], bracket: null, joined: false };
    this.menu.hidden = true;
    if (this.bar) this.bar.hidden = true;
    this.tournamentEl.hidden = false;
    this._renderTourneyJoin();
  }

  _renderTourneyJoin() {
    const t = this._tourney;
    this.tourneySub.textContent = `Joining tournament ${t.code}`;
    this.tourneyBody.innerHTML = `
      <p class="tourney-prompt">Enter your name to join</p>
      <div class="tourney-join">
        <input id="tourney-name" maxlength="16" placeholder="your name" autocomplete="off" />
        <button class="item tourney-join-go"><span class="item__caret">▸</span><span>Join</span></button>
      </div>
    `;
    const input = this.tourneyBody.querySelector('#tourney-name');
    const go = this.tourneyBody.querySelector('.tourney-join-go');
    const submit = async () => {
      const name = (input.value || '').trim().slice(0, 16) || 'Player';
      t.me = { id: this._tourneyMyId, name };
      go.disabled = true;
      try {
        await this.onTourneyJoin?.(t.code);
        this.onTourneySend?.('join', t.me);
        t.joined = true;
        t.roster = [t.me];
        this._renderTourneyLobby();
      } catch (e) { go.disabled = false; this.toast?.(`Join failed: ${e.message}`); }
    };
    go.onclick = submit;
    input.addEventListener('keydown', (e) => { if (e.code === 'Enter') submit(); });
    setTimeout(() => input.focus(), 0);
  }

  _renderTourneyLobby() {
    const t = this._tourney;
    if (t.bracket) return this._renderBracket();
    const isHost = t.role === 'host';
    this.tourneySub.textContent = isHost ? 'Your lobby is open — share the code' : `In lobby ${t.code}`;
    const rosterHtml = t.roster.length
      ? t.roster.map((p, i) => `<li class="tourney-roster-item"><span class="roster-idx">${String(i + 1).padStart(2, '0')}</span><span>${esc(p.name)}</span>${p.bot ? '<span class="tourney-tag">bot</span>' : p.host ? '<span class="tourney-tag">host</span>' : ''}</li>`).join('')
      : '<li class="tourney-roster-item muted">No players yet…</li>';
    const hostControls = isHost
      ? `<div class="tourney-lobby-actions">
           <button class="item tourney-addbot"><span class="item__caret">▸</span><span>Add a bot</span></button>
           <button class="item tourney-start"><span class="item__caret">▸</span><span>Start (${t.roster.length} player${t.roster.length === 1 ? '' : 's'})</span></button>
         </div>
         <p class="tourney-note">Byes fill empty slots automatically — add bots to reach a clean power of two.</p>`
      : '<p class="tourney-note">Waiting for the host to start…</p>';
    const hostBanner = isHost
      ? `<div class="tourney-code-row"><span class="tourney-code-label">ROOM CODE</span><strong class="tourney-code">${esc(t.code)}</strong></div>
         <div class="tourney-share"><input class="tourney-link" readonly value="${esc(t.link)}" /><button class="tourney-copy">Copy link</button></div>
         <p class="tourney-note">${t.kind === 'local' ? 'Local mode: open this link in other tabs. Add Supabase keys for cross-device play.' : 'Online: share this link — anyone can join.'}</p>`
      : '';
    this.tourneyBody.innerHTML = `
      ${hostBanner}
      <p class="tourney-prompt">Players (${t.roster.length})</p>
      <ul class="tourney-roster">${rosterHtml}</ul>
      ${hostControls}
    `;
    if (isHost) {
      const copy = this.tourneyBody.querySelector('.tourney-copy');
      if (copy) copy.onclick = async () => {
        try { await navigator.clipboard.writeText(t.link); copy.textContent = 'Copied!'; setTimeout(() => (copy.textContent = 'Copy link'), 1400); }
        catch { this.tourneyBody.querySelector('.tourney-link')?.select(); }
      };
      const addbot = this.tourneyBody.querySelector('.tourney-addbot');
      if (addbot) addbot.onclick = () => this._addBot();
      const start = this.tourneyBody.querySelector('.tourney-start');
      if (start) { start.disabled = t.roster.length < 2; start.onclick = () => this._startTourney(); }
    }
  }

  _addBot() {
    const t = this._tourney;
    const botCount = t.roster.filter((p) => p.bot).length + 1;
    t.roster.push({ id: 'bot-' + Math.random().toString(36).slice(2, 7), name: `Bot ${botCount}`, bot: true });
    this.onTourneySend?.('roster', t.roster);
    this.sfx.ui();
    this._renderTourneyLobby();
  }

  _startTourney() {
    const t = this._tourney;
    if (t.roster.length < 2) return;
    t.bracket = createTournament(t.roster.map((p) => ({ id: p.id, name: p.name })), { name: 'Flyball Cup' });
    this.onTourneySend?.('bracket', t.bracket);
    this.sfx.ui();
    this._renderBracket();
  }

  _renderBracket() {
    const t = this._tourney;
    const bracket = t.bracket;
    if (!bracket) return this._renderTourneyLobby();
    const isHost = t.role === 'host';
    this.tourneySub.textContent = isComplete(bracket) ? 'Champion crowned' : 'Single elimination · first to 11, win by 2';
    const rows = renderBracketLines(bracket).map((l) => {
      if (l.type === 'round') return `<div class="tourney-round">${l.text}</div>`;
      const canPick = isHost && l.playable;
      const name = (side, txt, mark) => `<button class="tourney-name ${mark === '✓' ? 'is-winner' : ''}" data-match="${l.id}" data-win="${side}" ${canPick ? '' : 'disabled'}>${mark === '✓' ? '✓ ' : ''}${esc(txt)}</button>`;
      const tag = l.score === 'bye' ? '<span class="tourney-tag">bye</span>' : '';
      return `<div class="tourney-match ${l.playable ? 'playable' : ''}">${name('p1', l.p1, l.w1)}<span class="tourney-vs">vs</span>${name('p2', l.p2, l.w2)}${tag}</div>`;
    }).join('');
    let footer = '';
    if (isComplete(bracket)) footer = `<div class="tourney-champion">🏆 CHAMPION — ${esc(bracket.champion.name)}</div>`;
    else if (isHost) footer = '<button class="item tourney-sim"><span class="item__caret">▸</span><span>Sim the remaining matches</span></button>';
    else footer = '<p class="tourney-note">The host is running the bracket…</p>';
    this.tourneyBody.innerHTML = rows + footer;
    if (!isHost) return;
    this.tourneyBody.querySelectorAll('.tourney-name[data-match]').forEach((b) => {
      if (b.disabled) return;
      b.onclick = () => {
        const m = currentMatches(bracket).find((mm) => mm.id === Number(b.dataset.match));
        if (!m) return;
        reportResult(bracket, m.id, (b.dataset.win === 'p1' ? m.p1 : m.p2).id);
        this.sfx.ui();
        this.onTourneySend?.('bracket', bracket);
        if (isComplete(bracket)) this.toast(`${bracket.champion.name} wins the cup!`);
        this._renderBracket();
      };
    });
    const sim = this.tourneyBody.querySelector('.tourney-sim');
    if (sim) sim.onclick = () => {
      for (const m of currentMatches(bracket)) {
        reportResult(bracket, m.id, (Math.random() < 0.5 ? m.p1 : m.p2).id);
      }
      this.onTourneySend?.('bracket', bracket);
      this.sfx.ui();
      if (isComplete(bracket)) this.toast(`${bracket.champion.name} wins the cup!`);
      this._renderBracket();
    };
  }

  // Inbound lobby messages, forwarded from main's net pipe.
  _onTourneyMessage(type, data) {
    const t = this._tourney;
    if (!t) return;
    if (type === 'join') {
      if (t.role !== 'host') return;
      if (!t.roster.some((p) => p.id === data.id)) {
        t.roster.push({ id: data.id, name: String(data.name || 'Player').slice(0, 16) });
        this.onTourneySend?.('roster', t.roster);
        if (!t.bracket) this._renderTourneyLobby();
      }
      return;
    }
    if (type === 'roster') {
      if (Array.isArray(data)) t.roster = data;
      if (!t.bracket) this._renderTourneyLobby();
      return;
    }
    if (type === 'bracket') {
      t.bracket = data;
      this._renderBracket();
    }
  }

  _onTourneyPresence(present) {
    // A late joiner may have missed earlier roster broadcasts; when the host
    // sees a new peer, re-send the current roster (and bracket if started).
    if (this._tourney?.role === 'host' && present) {
      this.onTourneySend?.('roster', this._tourney.roster);
      if (this._tourney.bracket) this.onTourneySend?.('bracket', this._tourney.bracket);
    }
  }

  closeTournament() {
    this.onTourneyLeave?.();
    this._tourney = null;
    if (this.tournamentEl) this.tournamentEl.hidden = true;
    this.showMenu();
  }

  // --- Versus (play a friend) -------------------------------------------

  _buildVersus() {
    const el = document.createElement('div');
    el.id = 'versus';
    el.hidden = true;
    el.innerHTML = `
      <div class="versus-head">
        <h1 class="title" data-versus-title>Versus<span class="blink">_</span></h1>
        <p class="tagline" data-versus-sub>First to 11, win by 2</p>
      </div>

      <div class="versus-lobby" data-versus-lobby>
        <p class="versus-label" data-versus-code-label>Room code</p>
        <div class="versus-code" data-versus-code>------</div>
        <div class="versus-share" data-versus-share>
          <input class="versus-link" data-versus-link type="text" readonly />
          <button class="item versus-copy" data-versus-copy><span class="item__caret">▸</span><span>Copy</span></button>
        </div>
        <p class="versus-status blink" data-versus-status>Waiting for opponent…</p>
        <p class="versus-note" data-versus-note></p>
      </div>

      <div class="versus-scoreboard" data-versus-scoreboard hidden>
        <div class="vs-grid">
          <div class="vs-side">
            <small class="vs-name">YOU</small>
            <span class="vs-score" data-vs-you>0</span>
          </div>
          <span class="vs-dash">–</span>
          <div class="vs-side">
            <small class="vs-name" data-vs-them-name>OPPONENT</small>
            <span class="vs-score" data-vs-them>0</span>
          </div>
        </div>
        <p class="versus-status" data-vs-serve>YOUR SERVE</p>
        <p class="versus-note" data-vs-target>First to 11</p>
      </div>

      <div class="hint">esc leave</div>
    `;
    document.body.appendChild(el);
    this.versusEl = el;
    this.versusTitle = el.querySelector('[data-versus-title]');
    this.versusSub = el.querySelector('[data-versus-sub]');
    this.versusLobby = el.querySelector('[data-versus-lobby]');
    this.versusCodeLabel = el.querySelector('[data-versus-code-label]');
    this.versusCode = el.querySelector('[data-versus-code]');
    this.versusShare = el.querySelector('[data-versus-share]');
    this.versusLink = el.querySelector('[data-versus-link]');
    this.versusStatus = el.querySelector('[data-versus-status]');
    this.versusNote = el.querySelector('[data-versus-note]');
    this.versusScoreboard = el.querySelector('[data-versus-scoreboard]');
    this.vsYou = el.querySelector('[data-vs-you]');
    this.vsThem = el.querySelector('[data-vs-them]');
    this.vsThemName = el.querySelector('[data-vs-them-name]');
    this.vsServe = el.querySelector('[data-vs-serve]');
    this.vsTarget = el.querySelector('[data-vs-target]');

    const copyBtn = el.querySelector('[data-versus-copy]');
    copyBtn.onclick = async () => {
      const link = this.versusLink.value;
      try {
        await navigator.clipboard.writeText(link);
        this.toast('Link copied');
      } catch {
        this.versusLink.select();
        this.toast('Press Ctrl/Cmd+C to copy');
      }
    };

    // Win overlay lives at a much higher z-index so it sits above everything.
    const win = document.createElement('div');
    win.id = 'versus-win';
    win.hidden = true;
    win.innerHTML = `
      <div class="versus-win-card">
        <h1 class="title" data-vw-title>You win!<span class="blink">_</span></h1>
        <p class="versus-win-score" data-vw-score>0 – 0</p>
        <button class="item versus-win-leave" data-vw-leave><span class="item__caret">▸</span><span>Back to menu</span></button>
      </div>
    `;
    document.body.appendChild(win);
    this.versusWinEl = win;
    this.vwTitle = win.querySelector('[data-vw-title]');
    this.vwScore = win.querySelector('[data-vw-score]');
    win.querySelector('[data-vw-leave]').onclick = () => {
      this.onVersusLeave?.();
      this.closeVersus();
    };
  }

  openVersusLobby({ role, code, link, kind } = {}) {
    this._versusRole = role || 'host';
    this.menu.hidden = true;
    if (this.bar) this.bar.hidden = true;
    if (this.tournamentEl) this.tournamentEl.hidden = true;
    this.versusWinEl.hidden = true;
    this.versusEl.hidden = false;

    // Reset to the lobby (waiting) view.
    this.versusLobby.hidden = false;
    this.versusScoreboard.hidden = true;
    if (this.vsThemName) this.vsThemName.textContent = 'OPPONENT';

    const isGuest = role === 'guest';
    this.versusTitle.innerHTML = isGuest
      ? `Joining<span class="blink">_</span>`
      : `Versus<span class="blink">_</span>`;

    this.versusCode.textContent = code ?? '------';
    this.versusLink.value = link ?? window.location.href;

    // Guests are just connecting — de-emphasise the code/copy affordances.
    this.versusCodeLabel.style.display = isGuest ? 'none' : '';
    this.versusCode.style.display = isGuest ? 'none' : '';
    this.versusShare.style.display = isGuest ? 'none' : '';

    this.versusStatus.textContent = isGuest
      ? `Joining ${code ?? ''}…`.trim()
      : 'Waiting for opponent…';

    this.versusNote.textContent = kind === 'local'
      ? 'Local mode: open this link in another tab; add Supabase keys for cross-device play.'
      : 'Online: send this link to anyone.';

    this.sfx?.ui?.();
  }

  // A local AI match reuses the versus scoreboard, but there's no lobby/room:
  // reveal #versus straight to the scoreboard (the same DOM setVersusOpponent
  // exposes) and label the opponent side with the bot's name.
  showBotMatch(opponentName) {
    this.menu.hidden = true;
    if (this.bar) this.bar.hidden = true;
    if (this.tournamentEl) this.tournamentEl.hidden = true;
    this.versusWinEl.hidden = true;
    this.versusEl.hidden = false;
    this._versusRole = 'host';

    this.versusTitle.innerHTML = `Versus<span class="blink">_</span>`;

    // Only the scoreboard — hide the lobby (code/share/waiting) section.
    this.versusLobby.hidden = true;
    this.versusScoreboard.hidden = false;
    if (this.vsThemName) this.vsThemName.textContent = String(opponentName || 'Bot').toUpperCase();
    this.sfx?.ui?.();
  }

  setVersusOpponent(present) {    if (!this.versusEl || this.versusEl.hidden) return;
    if (present) {
      this.versusLobby.hidden = true;
      this.versusScoreboard.hidden = false;
      this.toast('Opponent connected');
    } else {
      this.versusScoreboard.hidden = true;
      this.versusLobby.hidden = false;
      this.versusStatus.textContent = 'Waiting for opponent…';
    }
  }

  updateVersusScore(snapshot, myRole) {
    if (!snapshot) return;
    if (myRole) this._versusRole = myRole;
    const role = myRole || this._versusRole;
    const you = role === 'guest' ? snapshot.scoreGuest : snapshot.scoreHost;
    const them = role === 'guest' ? snapshot.scoreHost : snapshot.scoreGuest;
    if (this.vsYou) this.vsYou.textContent = you ?? 0;
    if (this.vsThem) this.vsThem.textContent = them ?? 0;
    const target = snapshot.target ?? 11;
    if (this.vsTarget) this.vsTarget.textContent = `First to ${target}`;
    if (this.vsServe) {
      this.vsServe.textContent = snapshot.server === role ? 'YOUR SERVE' : 'THEIR SERVE';
    }
  }

  showVersusWin(didWin, snapshot) {
    const role = this._versusRole;
    let scoreLine = '';
    if (snapshot) {
      const you = role === 'guest' ? snapshot.scoreGuest : snapshot.scoreHost;
      const them = role === 'guest' ? snapshot.scoreHost : snapshot.scoreGuest;
      scoreLine = `${you ?? 0} – ${them ?? 0}`;
    }
    this.vwTitle.innerHTML = didWin
      ? `You win!<span class="blink">_</span>`
      : `You lost.<span class="blink">_</span>`;
    this.vwScore.textContent = scoreLine;
    this.versusWinEl.hidden = false;
    this.sfx?.ui?.(didWin);
  }

  closeVersus() {
    if (this.versusEl) this.versusEl.hidden = true;
    if (this.versusWinEl) this.versusWinEl.hidden = true;
    if (this.versusScoreboard) this.versusScoreboard.hidden = true;
    if (this.versusLobby) this.versusLobby.hidden = false;
    this.showMenu();
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
