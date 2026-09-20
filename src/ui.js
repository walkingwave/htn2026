import './ui.css';
import { buildPauseMenu } from './menuModel.js';
import { getLeaderboard, submitScore, isWorthRecording } from './leaderboard.js';

// The flat-screen shell: a retro start menu, a one-line status bar, and a
// settings screen built from the shared menu model.
//
// None of this exists inside a headset — the immersive session only renders
// the 3D scene — so the same menu model is drawn again in world space by
// vrMenu.js. This file is what you use before putting the headset on, and
// what the on-screen preview runs on.

// Names come from other players through the leaderboard, so they are text to
// display, never markup to run.
function escapeHtml(text) {
  return String(text ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

export class UI {
  // `isInputBlocked` lets the caller veto keyboard commands — the in-headset
  // menu uses it so a keypress can't drive the game from behind an open
  // pause screen.
  constructor({
    xr,
    machine,
    game,
    settings,
    sfx,
    onStart,
    onExit,
    isInputBlocked,
    onRecenter,
    onVersusCreate,
    onVersusJoin,
    onVersusLeave,
    onRunSummary,
    invitedRoom = null,
    realtimeAvailable = false,
  }) {
    Object.assign(this, {
      xr,
      machine,
      game,
      settings,
      sfx,
      onStart,
      onExit,
      onRecenter,
      onVersusCreate,
      onVersusJoin,
      onVersusLeave,
      onRunSummary,
      realtimeAvailable,
    });
    this.isInputBlocked = isInputBlocked ?? (() => false);

    this._selected = 0;
    this._entries = [];
    this._toastTimer = null;
    this._lastRevision = -1;
    this._versus = null; // { role, code, link, kind } once a room is open

    this._buildMenu();
    this._buildBar();
    this._buildSettings();
    this._buildToast();
    this._buildVersusHud();
    this._buildScores();

    window.addEventListener('keydown', (e) => this._onKey(e));
    this.showMenu();

    // Arriving on a ?room=CODE link is an invitation, so the menu opens on
    // Versus with the code already filled in — one button from playing.
    if (invitedRoom) {
      this.setGame('versus');
      this.lobbyCode.value = invitedRoom;
      this._setLobbyStatus(`Invited to room ${invitedRoom} — join to play.`);
    }
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
      <div class="game-pick">
        <span class="game-pick__label">Game</span>
        <button class="key" data-game="arcade"><b>1</b>Arcade</button>
        <button class="key" data-game="coach"><b>2</b>Coach</button>
        <button class="key" data-game="versus"><b>3</b>Versus</button>
      </div>
      <div class="lobby" data-lobby hidden>
        <div class="lobby__row">
          <button class="key" data-lobby-host><b>▸</b>Host a match</button>
          <span class="lobby__or">or</span>
          <input
            class="lobby__code"
            data-lobby-code
            maxlength="6"
            placeholder="CODE"
            autocomplete="off"
            spellcheck="false"
          />
          <button class="key" data-lobby-join><b>▸</b>Join</button>
        </div>
        <div class="lobby__status" data-lobby-status></div>
        <div class="lobby__share" data-lobby-share hidden>
          <span class="lobby__link" data-lobby-link></span>
          <button class="key" data-lobby-copy><b>⧉</b>Copy link</button>
          <button class="key" data-lobby-leave><b>×</b>Leave</button>
        </div>
      </div>
      <div class="hint">
        ↑ ↓ select &nbsp;·&nbsp; enter start &nbsp;·&nbsp; L scores<br />
        <span data-menu-note></span>
      </div>
    `;
    document.body.appendChild(el);
    this.menu = el;
    this.list = el.querySelector('[data-list]');

    for (const btn of el.querySelectorAll('[data-game]')) {
      btn.onclick = () => this.setGame(btn.dataset.game);
    }

    this.lobby = el.querySelector('[data-lobby]');
    this.lobbyCode = el.querySelector('[data-lobby-code]');
    this.lobbyStatus = el.querySelector('[data-lobby-status]');
    this.lobbyShare = el.querySelector('[data-lobby-share]');
    this.lobbyLink = el.querySelector('[data-lobby-link]');
    el.querySelector('[data-lobby-host]').onclick = () => this._hostMatch();
    el.querySelector('[data-lobby-join]').onclick = () => this._joinMatch();
    el.querySelector('[data-lobby-copy]').onclick = () => this._copyRoomLink();
    el.querySelector('[data-lobby-leave]').onclick = () => this._leaveMatch();
    // Typing a code and pressing enter joins, which is what everyone tries.
    this.lobbyCode.onkeydown = (e) => {
      e.stopPropagation(); // the menu's arrow/enter handling isn't wanted here
      if (e.code === 'Enter') this._joinMatch();
    };

    this._entries = [
      { id: 'ar', label: 'Enter passthrough', note: '', disabled: true },
      { id: 'vr', label: 'Enter full VR', note: '', disabled: true },
      { id: 'desktop', label: 'Computer', note: 'preview', disabled: false },
    ];
    this._renderMenu();
    this._syncGamePick();
  }

  // Arcade is the drills and rally; Coach teaches one stroke at a time. It
  // is a separate game rather than another drill in the rotation, so it is
  // chosen here before you enter rather than cycled into by accident.
  setGame(value) {
    this.settings.set('game', value);
    this._syncGamePick();
    this.sfx.ui();
  }

  _syncGamePick() {
    const current = this.settings.get('game');
    for (const btn of this.menu.querySelectorAll('[data-game]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.game === current));
    }

    const versus = current === 'versus';
    this.lobby.hidden = !versus;
    if (versus && !this._versus) {
      this._setLobbyStatus(
        this.realtimeAvailable
          ? 'Host a match, or enter a friend’s code.'
          : 'Host a match, or enter a friend’s code. Without Supabase keys you can play anyone on this Wi-Fi.'
      );
    }
    // Backing out of Versus should not leave a room open behind the menu.
    if (!versus && this._versus) this._leaveMatch();
  }

  // --- Versus lobby -----------------------------------------------------

  // Which pipe the room is actually using. Worth saying out loud: the three
  // reach different distances, and "nothing happens" usually turns out to be
  // two players on two different ones.
  _transportNote() {
    const kind = this._versus?.kind;
    if (kind === 'websocket') return 'Connected over this Wi-Fi.';
    if (kind === 'supabase') return 'Connected over the internet.';
    if (kind === 'local') return 'Local only — this connects tabs on this machine, not another device.';
    return '';
  }

  _setLobbyStatus(text, tone = '') {
    this.lobbyStatus.textContent = text;
    this.lobbyStatus.dataset.tone = tone;
  }

  async _hostMatch() {
    if (this._versus) return;
    this.sfx.ui();
    this._setLobbyStatus('Opening room…');
    try {
      this._versus = await this.onVersusCreate?.();
      this.lobbyCode.value = this._versus.code;
      this.lobbyLink.textContent = this._versus.link;
      this.lobbyShare.hidden = false;
      this._setLobbyStatus(
        `Room ${this._versus.code} — waiting for your opponent. ` +
          `Send them this link; it has to be opened on this machine’s address, not their own. ` +
          this._transportNote()
      );
    } catch (err) {
      console.error('Failed to host a match', err);
      this._versus = null;
      this._setLobbyStatus(err.message ?? 'Could not open a room.', 'bad');
    }
  }

  async _joinMatch() {
    if (this._versus) return;
    const code = this.lobbyCode.value.trim().toUpperCase();
    if (!code) {
      this._setLobbyStatus('Enter the code your opponent gave you.', 'bad');
      return;
    }
    this.sfx.ui();
    this._setLobbyStatus(`Joining ${code}…`);
    try {
      this._versus = await this.onVersusJoin?.(code);
      this.lobbyShare.hidden = true;
      // Which side you ended up on is decided by who got there first, so say
      // so — otherwise the player who arrived first sits waiting for a serve
      // that is theirs to make.
      this._setLobbyStatus(
        this._versus.role === 'host'
          ? `Room ${code} — you got there first, so you serve. Waiting for them.`
          : `Joined ${code} — waiting for the host to serve. ${this._transportNote()}`
      );
    } catch (err) {
      console.error('Failed to join a match', err);
      this._versus = null;
      this._setLobbyStatus(err.message ?? 'Could not join that room.', 'bad');
    }
  }

  async _copyRoomLink() {
    const link = this.lobbyLink.textContent;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      this.toast('Link copied');
    } catch {
      // Clipboard access is refused in plenty of contexts; the link is on
      // screen either way, so select it and let them copy it by hand.
      const range = document.createRange();
      range.selectNodeContents(this.lobbyLink);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      this.toast('Copy the highlighted link');
    }
  }

  _leaveMatch() {
    this.onVersusLeave?.();
    this._versus = null;
    this.lobbyShare.hidden = true;
    this.versusHud.hidden = true;
    this.hideCountdown();
    this._hideVersusWin();
    this._setLobbyStatus('Left the room.');
  }

  // Whether a networked match is set up and ready to play.
  get inVersus() {
    return Boolean(this._versus);
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
    // Versus has nothing to play until a room exists, and walking into an
    // empty table wondering where the ball is would be a worse answer than
    // saying so.
    if (this.settings.get('game') === 'versus' && !this._versus) {
      this._setLobbyStatus('Host a match or join a code first.', 'bad');
      this.sfx.ui(false);
      return;
    }

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
      onRecenter: () => this.onRecenter?.(),
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
    // Record before tearing anything down — onExit resets the match state
    // this reads from.
    this.recordRun?.(this.onRunSummary?.() ?? {});
    this.settingsEl.hidden = true;
    this.scoresEl.hidden = true;
    this.versusHud.hidden = true;
    this.hideCountdown();
    this._hideVersusWin();
    this._versus = null;
    this.lobbyShare.hidden = true;
    this.xr.end();
    this.onExit?.(); // also closes the room, via main
    this.showMenu();
  }

  // --- Keyboard ---------------------------------------------------------

  _onKey(e) {
    if (!this.menu.hidden) {
      if (document.activeElement === this.lobbyCode) return; // typing a code
      if (e.code === 'Digit1') this.setGame('arcade');
      else if (e.code === 'Digit2') this.setGame('coach');
      else if (e.code === 'Digit3') this.setGame('versus');
      else if (e.code === 'KeyL') this.toggleScores();
      else if (e.code === 'Escape' && !this.scoresEl.hidden) this.toggleScores(false);
      else if (e.code === 'ArrowUp') this._moveMenu(-1);
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
    } else if (e.code === 'KeyC') {
      this.onRecenter?.();
    }
  }

  // --- Versus HUD -------------------------------------------------------
  //
  // The in-world scoreboard carries the match too, but a headset is not the
  // only way to play this: on a screen the flat overlay is the scoreboard.

  _buildVersusHud() {
    const el = document.createElement('div');
    el.id = 'versus';
    el.hidden = true;
    el.innerHTML = `
      <div class="versus__score">
        <span class="versus__side" data-versus-you>You <b>0</b></span>
        <span class="versus__dash">—</span>
        <span class="versus__side" data-versus-them><b>0</b> Them</span>
      </div>
      <div class="versus__state" data-versus-state>Waiting for opponent</div>
    `;
    document.body.appendChild(el);
    this.versusHud = el;

    this.countdownEl = document.createElement('div');
    this.countdownEl.id = 'countdown';
    this.countdownEl.hidden = true;
    document.body.appendChild(this.countdownEl);

    this.winEl = document.createElement('div');
    this.winEl.id = 'versus-win';
    this.winEl.hidden = true;
    this.winEl.innerHTML = `
      <div class="win__result" data-win-result>You win</div>
      <div class="win__score" data-win-score></div>
      <button class="key" data-win-exit><b>Esc</b>Back to menu</button>
    `;
    document.body.appendChild(this.winEl);
    this.winEl.querySelector('[data-win-exit]').onclick = () => this.quitToMenu();
  }

  setVersusOpponent(present) {
    this.versusHud.hidden = false;
    const state = this.versusHud.querySelector('[data-versus-state]');
    state.textContent = present ? 'Opponent connected' : 'Waiting for opponent';
    state.dataset.live = String(present);
    if (present && !this.menu.hidden) this._setLobbyStatus('Opponent connected — start when ready.');
    else if (!present && this._versus) this._setLobbyStatus('Opponent left the room.');
  }

  // `snap` is a VersusMatch snapshot; `role` is which side this browser is.
  updateVersusScore(snap, role) {
    this.versusHud.hidden = false;
    const you = role === 'guest' ? snap.scoreGuest : snap.scoreHost;
    const them = role === 'guest' ? snap.scoreHost : snap.scoreGuest;
    this.versusHud.querySelector('[data-versus-you] b').textContent = String(you);
    this.versusHud.querySelector('[data-versus-them] b').textContent = String(them);
    const serving = snap.server === role;
    this.versusHud.querySelector('[data-versus-state]').textContent = snap.winner
      ? 'Match over'
      : serving
        ? 'Your serve'
        : 'Their serve';
  }

  showCountdown(seconds) {
    this.countdownEl.hidden = false;
    this.countdownEl.textContent = String(seconds);
  }

  hideCountdown() {
    if (this.countdownEl) this.countdownEl.hidden = true;
  }

  showVersusWin(youWon, snap) {
    if (!this.winEl.hidden) return; // already showing; don't restart it
    this.hideCountdown();
    this.winEl.hidden = false;
    this.winEl.querySelector('[data-win-result]').textContent = youWon
      ? 'You win'
      : 'You lose';
    this.winEl.querySelector('[data-win-result]').dataset.won = String(youWon);
    this.winEl.querySelector('[data-win-score]').textContent =
      `${snap.scoreHost} — ${snap.scoreGuest}`;
    this.sfx.ui(youWon);
  }

  _hideVersusWin() {
    if (this.winEl) this.winEl.hidden = true;
  }

  // --- Scores -----------------------------------------------------------
  //
  // One board per game, because the three ask completely different things of
  // you and a single number across them would mean nothing.

  _buildScores() {
    const el = document.createElement('div');
    el.id = 'scores';
    el.hidden = true;
    el.innerHTML = `
      <div class="settings__title" data-scores-title>Scores</div>
      <div class="scores__name">
        <span class="row__label">Name</span>
        <input class="lobby__code scores__input" data-scores-name maxlength="24" autocomplete="off" />
      </div>
      <div class="scores__list" data-scores-list></div>
      <div class="hint">L / Esc to close</div>
    `;
    document.body.appendChild(el);
    this.scoresEl = el;
    this.scoresList = el.querySelector('[data-scores-list]');
    this.scoresName = el.querySelector('[data-scores-name]');
    this.scoresName.value = this.settings.get('playerName') ?? 'Player';
    this.scoresName.onkeydown = (e) => e.stopPropagation(); // typing, not commands
    this.scoresName.onchange = () =>
      this.settings.set('playerName', this.scoresName.value.trim() || 'Player');
  }

  async toggleScores(force) {
    const open = force ?? this.scoresEl.hidden;
    this.scoresEl.hidden = !open;
    this.sfx.ui(open);
    if (!open) return;

    const category = this.settings.get('game');
    this.scoresEl.querySelector('[data-scores-title]').textContent = `${category} scores`;
    this.scoresList.innerHTML = '<div class="row"><span class="row__label">Loading…</span></div>';

    const rows = await getLeaderboard(category);
    if (!rows.length) {
      this.scoresList.innerHTML =
        '<div class="row"><span class="row__label">No runs yet — play one</span></div>';
      return;
    }
    this.scoresList.innerHTML = rows
      .map(
        (row, i) => `
        <div class="row scores__row">
          <span class="row__label">${i + 1}. ${escapeHtml(row.player_name)}</span>
          <span class="row__value"><b>${row.score}</b></span>
        </div>`
      )
      .join('');
  }

  // Called when a run ends. Nothing is uploaded unless you actually played.
  async recordRun(summary) {
    const category = this.settings.get('game');
    if (!isWorthRecording(summary, category)) return;
    const name = this.settings.get('playerName') ?? 'Player';
    try {
      const entry = await submitScore(name, summary, category);
      this.toast(`Scored ${entry.score}`);
    } catch (err) {
      console.error('Could not record the run', err);
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
    const mode = this.settings.get('game');

    if (mode === 'versus') {
      // The machine's drills mean nothing in a match; the bar carries the
      // room instead, which is the one thing you might need to read out loud.
      this.bar.querySelector('[data-bar-mode]').textContent = 'Versus';
      this.bar.querySelector('[data-bar-stats]').textContent = this._versus
        ? `room ${this._versus.code} · ${this._versus.role}`
        : 'no room';
      this.bar.querySelector('[data-toggle-label]').textContent = 'Pause';
      return;
    }

    this.bar.querySelector('[data-bar-mode]').textContent =
      mode === 'coach'
        ? `Coach · ${this.machine.coachName ?? ''}`.trim()
        : machine.mode.name;
    this.bar.querySelector('[data-bar-stats]').textContent = machine.isTargetMode
      ? `${game.targetsHit} targets · ${game.returns} on table`
      : `streak ${game.streak} · ${game.returns}/${game.hits + game.misses} on table`;
    this.bar.querySelector('[data-toggle-label]').textContent = machine.enabled
      ? 'Pause'
      : 'Arm';
  }
}
