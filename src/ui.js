import './ui.css';
import { MODES } from './ballMachine.js';
import { buildPauseMenu } from './menuModel.js';
import { getNarrationSettings, setNarrationEnabled, setNarratorMode, sendInvite } from './backendApi.js';
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
    onTournamentStart,
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
      onTournamentStart,
      onRunSummary,
      realtimeAvailable,
    });
    this.isInputBlocked = isInputBlocked ?? (() => false);

    this._selected = 0;
    this._entries = [];
    this._toastTimer = null;
    this._lastRevision = -1;
    this._versus = null; // { role, code, link, kind } once a room is open
    this._tournamentOrganizer = false;
    this._tournamentWaiting = false;
    this._roomPlayerCount = 1;

    this._buildMenu();
    this._buildBar();
    this._buildSettings();
    this._buildToast();
    this._buildCoachPanel();
    this._buildVersusHud();
    this._buildTournamentHud();
    this._buildScores();
    this._buildCamPreview();
    if (this.settings.get('game') === 'tournament') {
      this._tournamentOrganizer = true;
      this.menu.dataset.tournamentHost = 'true';
    }

    window.addEventListener('keydown', (e) => this._onKey(e));
    this.showMenu();

    // Arriving on a ?room=CODE link is an invitation, so the menu opens on
    // Versus with the code already filled in — one button from playing.
    if (invitedRoom) {
      // Tournament invite links are the player flow: connect immediately,
      // keep the player on the medium picker, and wait for the organizer's
      // start signal instead of making them press Join or Start.
      // UI is constructed before main.js finishes declaring the network game
      // state. Defer the connection until module initialization completes;
      // otherwise enterVersus() reads the still-uninitialized versusBall let.
      queueMicrotask(() => {
        this._joinInvitedTournament(invitedRoom).catch((error) => {
          console.error('Failed to join invited tournament', error);
        });
      });
    }
  }

  // --- Start menu -------------------------------------------------------

  _buildMenu() {
    const el = document.createElement('div');
    el.id = 'menu';
    el.innerHTML = `
      <div class="crt"></div>
      <div>
        <h1 class="title">Paddle<span>·</span>Lab XR<span class="blink">_</span></h1>
        <p class="tagline">Hack the North 2026</p>
      </div>

      <div class="screen" data-screen="game">
        <div class="step__head"><span class="step__num">1</span>What do you want to play?</div>
        <div class="game-pick">
          <button class="game" data-game="tournament">
            <span class="game__key">1</span>
            <span class="game__name">Create a tournament</span>
            <span class="game__blurb">Bracket play · beta</span>
          </button>
          <button class="game" data-game="friend">
            <span class="game__key">2</span>
            <span class="game__name">Play a friend</span>
            <span class="game__blurb">Online match · beta</span>
          </button>
          <button class="game" data-game="bot">
            <span class="game__key">3</span>
            <span class="game__name">Play a standard bot</span>
            <span class="game__blurb">A physical AI opponent</span>
          </button>
          <button class="game" data-game="fly">
            <span class="game__key">4</span>
            <span class="game__name">Play a fly</span>
            <span class="game__blurb">Connectome-driven opponent</span>
          </button>
          <button class="game" data-game="drills">
            <span class="game__key">5</span>
            <span class="game__name">Drills</span>
            <span class="game__blurb">Practice shots against the machine</span>
          </button>
        </div>
        <div class="prompt blink">↑ ↓ SELECT · ENTER CONTINUE</div>
      </div>

      <div class="screen" data-screen="play" hidden>
        <button class="crumb" data-back>‹ <b data-crumb-game>ARCADE</b> — change game</button>
        <div class="step__head" data-input-step><span class="step__num">2</span>What do you have?</div>
        <div class="menu-list" data-list></div>
        <div class="lobby" data-lobby hidden>
          <div class="step__head"><span class="step__num">✦</span><span data-lobby-title>Set up the match</span></div>
          <div class="lobby__row">
            <button class="key" data-lobby-host><b>▸</b>Start a room</button>
            <span data-lobby-join-controls>
              <span class="lobby__or">or join one</span>
              <input
                class="lobby__code"
                data-lobby-code
                maxlength="6"
                placeholder="CODE"
                autocomplete="off"
                spellcheck="false"
              />
              <button class="key" data-lobby-join><b>▸</b>Join</button>
            </span>
            <button class="key" data-lobby-start hidden><b>▶</b>Start tournament</button>
          </div>
          <div class="lobby__status" data-lobby-status></div>
          <div class="lobby__players" data-lobby-players></div>
          <div class="lobby__share" data-lobby-share hidden>
            <span class="lobby__link" data-lobby-link></span>
            <button class="key" data-lobby-copy><b>⧉</b>Copy link</button>
            <button class="key" data-lobby-leave><b>×</b>Leave</button>
            <div class="lobby__invite">
              <span class="lobby__invite-label">Text an invite</span>
              <input class="lobby__phone" data-lobby-phone placeholder="+1 416…" inputmode="tel" autocomplete="tel" />
              <button class="key" data-lobby-invite><b>▸</b>Send iMessage</button>
            </div>
          </div>
        </div>
        <div class="tournament-waiting" data-tournament-waiting hidden></div>
        <div class="tournament-room-status" data-tournament-room-status hidden></div>
        <div class="prompt blink">↑ ↓ SELECT · ENTER START</div>
      </div>

      <div class="hint">
        <b>Esc</b> back &nbsp;·&nbsp; <b>L</b> scores<br />
        <span data-menu-note></span>
      </div>
    `;
    document.body.appendChild(el);
    this.menu = el;
    this.list = el.querySelector('[data-list]');
    this._screens = {
      game: el.querySelector('[data-screen="game"]'),
      play: el.querySelector('[data-screen="play"]'),
    };
    this._crumbGame = el.querySelector('[data-crumb-game]');
    this._screen = 'game';
    this._productChoices = ['tournament', 'friend', 'bot', 'fly', 'drills'];
    this._gameIndex = 0;
    el.querySelector('[data-back]').onclick = () => this.setScreen('game');

    for (const btn of el.querySelectorAll('[data-game]')) {
      btn.onclick = () => this.chooseGame(btn.dataset.game);
    }

    this.lobby = el.querySelector('[data-lobby]');
    this.lobbyJoinControls = el.querySelector('[data-lobby-join-controls]');
    this.tournamentWaiting = el.querySelector('[data-tournament-waiting]');
    this.tournamentRoomStatus = el.querySelector('[data-tournament-room-status]');
    this.inputStep = el.querySelector('[data-input-step]');
    this.lobbyTitle = el.querySelector('[data-lobby-title]');
    this.lobbyPlayers = el.querySelector('[data-lobby-players]');
    this.lobbyStart = el.querySelector('[data-lobby-start]');
    this.lobbyCode = el.querySelector('[data-lobby-code]');
    this.lobbyStatus = el.querySelector('[data-lobby-status]');
    this.lobbyShare = el.querySelector('[data-lobby-share]');
    this.lobbyLink = el.querySelector('[data-lobby-link]');
    el.querySelector('[data-lobby-host]').onclick = () => this._hostMatch();
    el.querySelector('[data-lobby-join]').onclick = () => this._joinMatch();
    el.querySelector('[data-lobby-copy]').onclick = () => this._copyRoomLink();
    el.querySelector('[data-lobby-leave]').onclick = () => this._leaveMatch();
    this.lobbyPhone = el.querySelector('[data-lobby-phone]');
    el.querySelector('[data-lobby-invite]').onclick = () => this._sendLinqInvite();
    this.lobbyPhone.onkeydown = (e) => {
      e.stopPropagation();
      if (e.code === 'Enter') this._sendLinqInvite();
    };
    this.lobbyStart.onclick = () => this._startTournament();
    // Typing a code and pressing enter joins, which is what everyone tries.
    this.lobbyCode.onkeydown = (e) => {
      e.stopPropagation(); // the menu's arrow/enter handling isn't wanted here
      if (e.code === 'Enter') this._joinMatch();
    };

    // Named for where you end up, with the trade-off spelled out, rather than
    // for the WebXR session mode being requested. "Enter passthrough" means
    // nothing to someone who has not read the spec.
    this._entries = [
      { id: 'ar', label: 'In my room', note: 'headset · passthrough', disabled: true },
      { id: 'vr', label: 'In the arena', note: 'headset · full VR', disabled: true },
      { id: 'desktop', label: 'On this screen', note: 'mouse or webcam paddle', disabled: false },
      { id: 'camera-hand', label: 'Hand tracking', note: 'webcam · bare hand', disabled: false },
    ];
    this._entries = [
      { id: 'vr', label: 'A VR headset', note: 'headset', disabled: true },
      { id: 'camera', label: 'A ping pong paddle', note: 'webcam', disabled: false },
      { id: 'camera-hand', label: 'A hand', note: 'webcam · hand tracking', disabled: false },
      { id: 'phone', label: 'A phone', note: 'beta', disabled: true },
      { id: 'desktop', label: 'Nothing — just the mouse', note: '', disabled: false },
    ];
    this._renderMenu();
    this._setProductCursor(this._gameIndex, false);
  }

  // The menu is two screens shown one after the other — pick a game, then
  // pick how to play it — the way a cabinet asks one question at a time.
  // One screen with both questions on it meant nobody read the second one.
  setScreen(name) {
    this._screen = name;
    this._screens.game.hidden = name !== 'game';
    // Re-apply the role-specific tournament layout whenever the screen opens;
    // this also handles returning to a remembered tournament setting where
    // setGame() did not emit a change event.
    if (name === 'play' && this.settings.get('game') === 'tournament') {
      this._syncGamePick();
    }
    this._screens.play.hidden = name !== 'play';
    if (name === 'play') {
      this._crumbGame.textContent = this._productLabel(this._productMode);
      // Land the cursor on something you can actually press Enter on —
      // carrying over a selection parked on a greyed-out headset row made
      // Enter silently do nothing.
      if (this._entries[this._selected]?.disabled) {
        const first = this._entries.findIndex((entry) => !entry.disabled);
        if (first >= 0) this._selected = first;
        this._renderMenu();
      }
    }
  }

  // Choosing a game answers screen one, so it also turns the page.
  chooseGame(value) {
    this._setProductCursor(this._productChoices.indexOf(value), false);
    this._productMode = value;
    if (value === 'tournament') {
      // Creating a tournament is the organizer flow. Participants enter from
      // an invite and are switched into the player flow after joining.
      this._tournamentOrganizer = true;
      this.menu.dataset.tournamentHost = 'true';
      this.setGame('tournament');
      this.setScreen('play');
      return;
    }

    if (value === 'friend') {
      this._tournamentOrganizer = false;
      delete this.menu.dataset.tournamentHost;
      this.setGame('versus');
    } else {
      this._tournamentOrganizer = false;
      delete this.menu.dataset.tournamentHost;
      this.setGame('arcade');
      this.settings.set('difficulty', value === 'fly' ? 'fly' : 'normal');
      const modeType = value === 'drills' ? 'drill' : 'rally';
      const modeIndex = MODES.findIndex((mode) => mode.type === modeType);
      if (modeIndex >= 0) this.machine.modeIndex = modeIndex;
    }
    this.setScreen('play');
  }

  _productLabel(value) {
    return {
      friend: 'PLAY A FRIEND',
      bot: 'PLAY A STANDARD BOT',
      fly: 'PLAY A FLY',
      drills: 'DRILLS',
      tournament: 'CREATE A TOURNAMENT',
    }[value] ?? 'PLAY A STANDARD BOT';
  }

  _setProductCursor(index, sound = true) {
    if (index < 0) return;
    this._gameIndex = index;
    for (const btn of this.menu.querySelectorAll('[data-game]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.game === this._productChoices[index]));
    }
    if (sound) this.sfx.ui();
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
    const versus = this.settings.get('game') === 'versus';
    const tournament = this.settings.get('game') === 'tournament';
    const tournamentParticipant = tournament && !this._tournamentOrganizer && Boolean(this._versus);
    this.lobby.hidden = !versus && !tournament || tournamentParticipant;
    this.list.hidden = tournament && !tournamentParticipant;
    this.inputStep.hidden = tournament && !tournamentParticipant;
    this.inputStep.innerHTML = tournamentParticipant
      ? '<span class="step__num">2</span>What is your paddle medium?'
      : tournament
        ? ''
        : '<span class="step__num">2</span>What do you have?';
    this.lobbyTitle.textContent = tournament ? 'Invite players to your tournament' : 'Set up the match';
    this.lobbyJoinControls.hidden = tournament && this._tournamentOrganizer;
    this.lobbyStart.hidden = !tournament || !this._versus || this._versus.role !== 'host';
    if (tournament && !this._versus) {
      this._setLobbyStatus('Create a room, then send the invite link to the players you want in the bracket.');
    } else if (versus && !this._versus) {
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

  startTournamentParticipant() {
    if (this.settings.get('game') !== 'tournament' || !this._versus) return;
    this._tournamentWaiting = false;
    this.tournamentWaiting.hidden = true;
    this.sfx.unlock();
    this.menu.hidden = true;
    this.bar.hidden = false;
    this.tournamentHud.hidden = false;
    this.onStart?.(null);
  }

  _startTournament() {
    if (this.settings.get('game') !== 'tournament' || !this._versus) return;
    if (this._versus.role !== 'host') return;
    if (this._roomPlayerCount < 2) {
      this._setLobbyStatus('Waiting for at least 2 players.');
      return;
    }
    this.sfx.ui();
    this.onTournamentStart?.();
    // The organizer stays in the lobby/dashboard; only invited players enter
    // the game. The host must never be forced to choose a paddle input.
    this.tournamentHud.hidden = false;
    this.updateTournament(this._tournamentSnapshot);
    this._setLobbyStatus('Tournament started — you are the host. Watch the bracket for match results.');
  }

  async _hostMatch() {
    if (this._versus) return;
    this._tournamentOrganizer = this.settings.get('game') === 'tournament';
    this.sfx.ui();
    this._setLobbyStatus('Opening room…');
    try {
      this._versus = await this.onVersusCreate?.();
      this.lobbyCode.value = this._versus.code;
      this.lobbyLink.textContent = this._versus.link;
      this.lobbyShare.hidden = false;
      this.lobbyStart.hidden = this.settings.get('game') !== 'tournament' || !this._tournamentOrganizer;
      this._roomPlayerCount = 1;
      this.lobbyStart.disabled = true;
      if (this._tournamentOrganizer) {
        this.list.hidden = true;
        this.inputStep.hidden = true;
        this.inputStep.innerHTML = '';
        this.lobbyJoinControls.hidden = true;
      }
      this._setLobbyStatus(
        `${this.settings.get('game') === 'tournament' ? 'Tournament room' : 'Room'} ${this._versus.code} — waiting for players. ` +
          `Send them this link; it has to be opened on this machine’s address, not their own. ` +
          this._transportNote()
      );
    } catch (err) {
      console.error('Failed to host a match', err);
      this._versus = null;
      this._setLobbyStatus(err.message ?? 'Could not open a room.', 'bad');
    }
  }

  async _joinInvitedTournament(code) {
    this.chooseGame('tournament');
    this._tournamentOrganizer = false;
    delete this.menu.dataset.tournamentHost;
    this.lobbyCode.value = code;
    await this._joinMatch();
  }

  async _joinMatch() {
    if (this._versus) return;
    const code = this.lobbyCode.value.trim().toUpperCase();
    if (!code) {
      this._setLobbyStatus('Enter the code your opponent gave you.', 'bad');
      return;
    }
    // Checked here so a typo reads as a typo. Left to the relay it came back
    // as "Invalid room join", which is true, unhelpful, and looks like the
    // game is broken rather than the code being wrong.
    if (!/^[A-Z0-9]{4,12}$/.test(code)) {
      this._setLobbyStatus('Room codes are letters and numbers, six of them.', 'bad');
      return;
    }
    this.sfx.ui();
    this._setLobbyStatus(`Joining ${code}…`);
    try {
      this._tournamentOrganizer = false;
      delete this.menu.dataset.tournamentHost;
      this._versus = await this.onVersusJoin?.(code);
      this.lobbyShare.hidden = true;
      this.lobbyStart.hidden = true;
      if (this.settings.get('game') === 'tournament') {
        this._tournamentWaiting = true;
        this._roomPlayerCount = 1;
        this.tournamentWaiting.textContent =
          `JOINED ROOM ${code} · CHOOSE YOUR PADDLE MEDIUM · WAITING FOR HOST TO START`;
        this.tournamentWaiting.hidden = false;
        this._setTournamentRoomStatus('Waiting for at least 2 players…');
        // Participants choose their own input medium; the organizer does not.
        this.lobby.hidden = true;
        this.list.hidden = false;
        this.inputStep.hidden = false;
        this.inputStep.innerHTML = '<span class="step__num">2</span>What is your paddle medium?';
        const firstPlayable = this._entries.findIndex((entry) => !entry.disabled);
        if (firstPlayable >= 0) this._selected = firstPlayable;
        this._renderMenu();
      }
      // Which side you ended up on is decided by who got there first, so say
      // so — otherwise the player who arrived first sits waiting for a serve
      // that is theirs to make.
        this._setLobbyStatus(
        this._versus.role === 'host'
          ? `Room ${code} — you got there first, so you serve. Waiting for them.`
          : this.settings.get('game') === 'tournament'
            ? `Joined ${code} — waiting for the host to start the tournament. ${this._transportNote()}`
            : `Joined ${code} — waiting for the host to serve. ${this._transportNote()}`
      );
    } catch (err) {
      console.error('Failed to join a match', err);
      this._versus = null;
      this._setLobbyStatus(err.message ?? 'Could not join that room.', 'bad');
    }
  }

  async _sendLinqInvite() {
    const phoneNumber = this.lobbyPhone.value.trim().replace(/[()\s-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
      this._setLobbyStatus('Use an international number, for example +14165551234.', 'bad');
      return;
    }
    const roomLink = this.lobbyLink.textContent;
    if (!roomLink) return;
    this.sfx.ui();
    this._setLobbyStatus('Sending the iMessage invite…');
    try {
      await sendInvite(phoneNumber, roomLink);
      this._setLobbyStatus('Invite sent — they can tap the link to join.', 'good');
      this.toast('Invite sent');
    } catch (err) {
      console.error('Failed to send Linq invite', err);
      this._setLobbyStatus(err.message ?? 'Could not send the invite.', 'bad');
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
    this.hideCoachPanel();
    this.lobbyShare.hidden = true;
    this.lobbyStart.hidden = true;
    this.lobbyStart.disabled = false;
    this.lobbyJoinControls.hidden = false;
    this.lobbyPlayers.textContent = '';
    this._tournamentOrganizer = false;
    this._tournamentWaiting = false;
    this._roomPlayerCount = 1;
    this.tournamentWaiting.hidden = true;
    this.tournamentRoomStatus.hidden = true;
    delete this.menu.dataset.tournamentHost;
    this.versusHud.hidden = true;
    this.tournamentHud.hidden = true;
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
      // Three columns, so the caret, the place and the caption line up down
      // the list instead of drifting with the length of each label.
      b.innerHTML =
        `<span class="item__caret">▸</span><span>${entry.label}</span>` +
        `<span class="item__note">${entry.note ?? ''}</span>`;
      b.onmouseenter = () => {
        this._selected = i;
        // Hover moves the caret only. The chosen paddle medium is committed
        // on click, so merely browsing rows does not change the status line.
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

  _syncTournamentWaiting() {
    if (!this._tournamentWaiting || !this.tournamentWaiting || !this._versus) return;
    const entry = this._entries[this._selected];
    if (!entry || entry.disabled) return;
    const note = entry.note ? ` · ${entry.note}` : '';
    this.tournamentWaiting.textContent =
      `PADDLE MEDIUM: ${entry.label}${note} · WAITING FOR HOST TO START`;
    this.tournamentWaiting.hidden = false;
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
    if (this._tournamentWaiting) this._showTournamentMedium(entry);
    if (entry.id === 'camera') {
      this.settings.set('paddleSource', 'camera');
      if (this._tournamentWaiting) return this._showTournamentMedium(entry);
      this._launch(null);
    } else if (entry.id === 'camera-hand') {
      this.settings.set('paddleSource', 'camera-hand');
      if (this._tournamentWaiting) return this._showTournamentMedium(entry);
      this._launch(null);
    } else if (entry.id === 'desktop') {
      // On desktop, the controller source falls back to the mouse. Do not
      // reuse a saved webcam/hand selection when Computer was requested.
      this.settings.set('paddleSource', 'controller');
      if (this._tournamentWaiting) return this._showTournamentMedium(entry);
      this._launch(null);
    } else {
      if (this._tournamentWaiting) return this._showTournamentMedium(entry);
      this._launch('immersive-vr');
    }
  }

  _showTournamentMedium(entry) {
    const note = entry.note ? ` · ${entry.note}` : '';
    this.tournamentWaiting.textContent =
      `PADDLE MEDIUM: ${entry.label}${note} · WAITING FOR HOST TO START`;
    this.tournamentWaiting.hidden = false;
  }

  _setTournamentRoomStatus(text) {
    if (!this.tournamentRoomStatus) return;
    this.tournamentRoomStatus.textContent = text;
    this.tournamentRoomStatus.hidden = false;
  }

  applyXRSupport(support) {
    const vr = this._entries.find((entry) => entry.id === 'vr');
    vr.disabled = !support['immersive-vr'];
    vr.note = support['immersive-vr'] ? 'headset · full VR' : 'needs a headset';
    const menuNote = this.menu.querySelector('[data-menu-note]');
    menuNote.textContent = support['immersive-vr']
      ? 'Headset ready'
      : 'Open this page in the Meta Quest Browser to play in a headset';
    this._selected = this._entries.findIndex((entry) => !entry.disabled);
    if (this._selected < 0) this._selected = 0;
    this._renderMenu();
    return;

    this._entries[0].disabled = !support['immersive-ar'];
    this._entries[1].disabled = !support['immersive-vr'];
    this._entries[0].note = support['immersive-ar']
      ? 'headset · passthrough'
      : 'needs a headset';
    this._entries[1].note = support['immersive-vr']
      ? 'headset · full VR'
      : 'needs a headset';

    const note = this.menu.querySelector('[data-menu-note]');
    note.textContent = support['immersive-ar'] || support['immersive-vr']
      ? 'Headset ready'
      : 'Open this page in the Meta Quest Browser to play in a headset';

    this._selected = this._entries.findIndex((e) => !e.disabled);
    if (this._selected < 0) this._selected = 0;
    this._renderMenu();
  }

  async  _launch(mode) {
    // Versus has nothing to play until a room exists, and walking into an
    // empty table wondering where the ball is would be a worse answer than
    // saying so.
    if ((this.settings.get('game') === 'versus' || this.settings.get('game') === 'tournament') && !this._versus) {
      this._setLobbyStatus('Create a room or join an invite code first.', 'bad');
      this.sfx.ui(false);
      return;
    }

    this.sfx.unlock(); // first user gesture — the only moment audio can start
    this.sfx.ui();
    this.menu.hidden = true;
    this.bar.hidden = false;
    this.tournamentHud.hidden = this.settings.get('game') !== 'tournament';
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
    if (this._screens) this.setScreen('game');
    if (this.bar) this.bar.hidden = true;
    if (this.settingsEl) this.settingsEl.hidden = true;
  }

  // --- Coaching panel --------------------------------------------------

  _buildCoachPanel() {
    const el = document.createElement('aside');
    el.id = 'coach-panel';
    el.hidden = true;
    el.innerHTML = `
      <div class="coach-panel__head">
        <span>COACH</span>
        <span data-coach-status>LOCAL</span>
        <span class="coach-panel__controls">
          <button data-coach-audio aria-label="Toggle coaching narration"></button>
          <button data-coach-voice aria-label="Change narrator"></button>
        </span>
      </div>
      <div class="coach-panel__scenario" data-coach-scenario>Ready</div>
      <div class="coach-panel__score" data-coach-score>--%</div>
      <div class="coach-panel__metrics" data-coach-metrics></div>
      <div class="coach-panel__feedback" data-coach-feedback>Complete a stroke to get feedback.</div>
      <div class="coach-panel__summary" data-coach-summary hidden></div>
    `;
    document.body.appendChild(el);
    this.coachPanel = el;
    this.coachScenario = el.querySelector('[data-coach-scenario]');
    this.coachScore = el.querySelector('[data-coach-score]');
    this.coachMetrics = el.querySelector('[data-coach-metrics]');
    this.coachFeedback = el.querySelector('[data-coach-feedback]');
    this.coachSummary = el.querySelector('[data-coach-summary]');
    this.coachStatus = el.querySelector('[data-coach-status]');
    this.coachAudio = el.querySelector('[data-coach-audio]');
    this.coachVoice = el.querySelector('[data-coach-voice]');
    this.coachAudio.onclick = () => {
      const settings = getNarrationSettings();
      setNarrationEnabled(!settings.enabled);
      this._updateNarrationControls();
    };
    this.coachVoice.onclick = () => {
      const mode = getNarrationSettings().mode;
      const next = mode === 'auto' ? 'a' : mode === 'a' ? 'b' : 'auto';
      setNarratorMode(next);
      this._updateNarrationControls();
    };
    this._updateNarrationControls();
  }

  _updateNarrationControls() {
    const { enabled, mode } = getNarrationSettings();
    if (this.coachAudio) {
      this.coachAudio.textContent = enabled ? '🔊' : '🔇';
      this.coachAudio.title = enabled ? 'Mute coaching narration' : 'Enable coaching narration';
      this.coachAudio.setAttribute('aria-pressed', String(enabled));
    }
    if (this.coachVoice) {
      this.coachVoice.textContent = mode === 'auto' ? 'AUTO' : `VOICE ${mode.toUpperCase()}`;
      this.coachVoice.title = 'Cycle narrator: auto, narrator A, narrator B';
    }
  }

  showCoachScore(score, scenario = '') {
    if (!this.coachPanel) return;
    this.coachPanel.hidden = false;
    this.coachScenario.textContent = scenario ? scenario.replaceAll('-', ' ') : 'Coached stroke';
    this.coachScore.textContent = `${score?.total ?? 0}%`;
    this.coachMetrics.textContent = score
      ? `PATH ${score.path ?? 0} · SYNC ${score.sync ?? 0} · FACE ${score.face ?? 0} · TIME ${score.timing ?? 0}`
      : '';
    this.coachFeedback.textContent = score?.note || 'Feedback pending…';
    this.coachSummary.hidden = true;
  }

  showCoachFeedback(text) {
    if (!this.coachPanel || !text) return;
    this.coachPanel.hidden = false;
    this.coachFeedback.textContent = text;
  }

  showMatchSummary(text) {
    if (!this.coachPanel || !text) return;
    this.coachPanel.hidden = false;
    this.coachScenario.textContent = 'Post-match summary';
    this.coachSummary.hidden = false;
    this.coachSummary.textContent = text;
  }

  showProfileSummary(text) {
    if (!this.coachPanel || !text) return;
    this.coachPanel.hidden = false;
    this.coachScenario.textContent = 'Your recurring trends';
    this.coachSummary.hidden = false;
    this.coachSummary.textContent = text;
  }

  setCoachProfileStatus(status) {
    if (this.coachStatus) this.coachStatus.textContent = status;
  }

  hideCoachPanel() {
    if (this.coachPanel) this.coachPanel.hidden = true;
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
    el.querySelector('[data-act="serve"]').onclick = () => this.serveOne();
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
      inXR: Boolean(this.xr.session),
      machine: this.machine,
      game: this.game,
      settings: this.settings,
      onResume: () => this.toggleSettings(false),
      onRecenter: () => this.onRecenter?.(),
      onExit: () => this.quitToMenu(),
    });
  }

  // --- Commands (shared by clicks, keys and the VR menu) ----------------

  // The bottom bar's commands drive the ball machine, and the machine only
  // runs in Arcade. Coach places its own balls and Versus is fed by the other
  // player, so these have to be refused rather than quietly doing something —
  // pressing S in a match used to fire a stray ball into it that only one
  // side could see, and D silently rotated a drill you would meet again the
  // next time you played Arcade.
  _machineCommandsAllowed(what) {
    const game = this.settings.get('game');
    if (game === 'arcade') return true;
    this.toast(game === 'versus' ? `No ${what} in a match` : `No ${what} in Coach`);
    this.sfx.ui(false);
    return false;
  }

  togglePause() {
    if (!this._machineCommandsAllowed('pausing')) return;
    this.machine.enabled = !this.machine.enabled;
    this.game.revision++;
    this.sfx.ui(this.machine.enabled);
    this.toast(this.machine.enabled ? 'Armed' : 'Paused');
  }

  nextMode() {
    if (!this._machineCommandsAllowed('mode change')) return;
    const mode = this.machine.nextDrill();
    this.game.revision++;
    this.sfx.ui();
    this.toast(mode.name);
  }

  serveOne() {
    if (!this._machineCommandsAllowed('serving')) return;
    this.machine.serve();
  }

  toggleSettings(force) {
    const open = force ?? this.settingsEl.hidden;
    this.settingsEl.hidden = !open;
    if (open) this._renderSettings();
    this.sfx.ui(open);
  }

  quitToMenu() {
    this.hideCoachPanel();
    // Record before tearing anything down — onExit resets the match state
    // this reads from.
    this.recordRun?.(this.onRunSummary?.() ?? {});
    this.settingsEl.hidden = true;
    this.scoresEl.hidden = true;
    this.versusHud.hidden = true;
    this.tournamentHud.hidden = true;
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

      // The scores panel covers the menu, so it takes the keyboard with it.
      // Without this, Enter started the game behind it — you ended up playing
      // under a leaderboard — and the number keys changed a game you could
      // not see.
      if (!this.scoresEl.hidden) {
        if (e.code === 'KeyL' || e.code === 'Escape' || e.code === 'Enter') {
          e.preventDefault();
          this.toggleScores(false);
        }
        return;
      }

      if (e.code === 'Digit1') this.chooseGame('tournament');
      else if (e.code === 'Digit2') this.chooseGame('friend');
      else if (e.code === 'Digit3') this.chooseGame('bot');
      else if (e.code === 'Digit4') this.chooseGame('fly');
      else if (e.code === 'Digit5') this.chooseGame('drills');
      else if (e.code === 'KeyL') this.toggleScores();
      else if (e.code === 'Escape' || e.code === 'Backspace') {
        if (this._screen === 'play') this.setScreen('game');
      } else if (this._screen === 'game') {
        // Product choices map onto game settings, so their cursor must be
        // separate from the underlying Arcade/Versus setting.
        const games = this._productChoices;
        if (e.code === 'ArrowUp') this._setProductCursor((this._gameIndex + games.length - 1) % games.length);
        else if (e.code === 'ArrowDown') this._setProductCursor((this._gameIndex + 1) % games.length);
        else if (e.code === 'Enter' || e.code === 'Space') {
          e.preventDefault();
          this.chooseGame(games[this._gameIndex]);
        }
      } else if (e.code === 'ArrowUp') this._moveMenu(-1);
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
      this.serveOne();
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

  _buildTournamentHud() {
    const el = document.createElement('div');
    el.id = 'tournament-hud';
    el.hidden = true;
    el.innerHTML = '<div class="tournament__title">TOURNAMENT</div><div data-tournament-round></div><pre data-tournament-bracket></pre><div data-tournament-score></div>';
    document.body.appendChild(el);
    this.tournamentHud = el;
  }

  updateTournament(snapshot) {
    if (!snapshot || !this.tournamentHud) return;
    this._tournamentSnapshot = snapshot;
    this.tournamentHud.hidden = false;
    const current = snapshot.matches.find((match) => match.id === snapshot.currentMatchId);
    this.tournamentHud.querySelector('[data-tournament-round]').textContent = snapshot.finished ? 'CHAMPION' : `ROUND ${current.round + 1} · FIRST TO ${snapshot.target}`;
    this.tournamentHud.querySelector('[data-tournament-score]').textContent = current ? `${current.player1} ${current.score1} — ${current.score2} ${current.player2}` : '';
    this.tournamentHud.querySelector('[data-tournament-bracket]').textContent = snapshot.matches
      .map((match) => `${match.round === 0 ? 'SEMIFINAL' : match.round === 1 ? 'FINAL' : 'CHAMPIONSHIP'}  ${match.player1} ${match.score1} — ${match.score2} ${match.player2}${match.winner ? `  ✓ ${match.winner}` : ''}`)
      .join('\\n');
  }

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

  // Force the line under the score to say something specific — used when the
  // room dies, where "waiting for opponent" would be a lie.
  setVersusState(text) {
    this.versusHud.hidden = false;
    const state = this.versusHud.querySelector('[data-versus-state]');
    state.textContent = text;
    state.dataset.live = 'false';
  }

  setVersusOpponent(present, playerCount = present ? 2 : 1) {
    this._roomPlayerCount = Math.max(1, playerCount);
    this.versusHud.hidden = false;
    const state = this.versusHud.querySelector('[data-versus-state]');
    state.textContent = present ? 'Opponent connected' : 'Waiting for opponent';
    state.dataset.live = String(present);
    if (this.settings.get('game') === 'tournament') {
      if (this._tournamentOrganizer && this._versus) {
        this.lobbyStart.disabled = this._roomPlayerCount < 2;
        this._setLobbyStatus(
          this._roomPlayerCount < 2
            ? 'Waiting for at least 2 players.'
            : `${this._roomPlayerCount} players connected — start tournament when ready.`
        );
      } else if (this._tournamentWaiting) {
        this._setTournamentRoomStatus(
          this._roomPlayerCount < 2
            ? 'Waiting for at least 2 players…'
            : `${this._roomPlayerCount} players connected · waiting for host to start`
        );
      }
    } else if (present && !this.menu.hidden) this._setLobbyStatus('Opponent connected — start when ready.');
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

  // --- Webcam preview ---------------------------------------------------
  //
  // Colour tracking fails for reasons you can see instantly and cannot guess
  // at all: it locked onto a red jumper, the rubber is in shadow, your hand is
  // over the face. A thumbnail of what the camera is matching turns "it
  // doesn't work" into "move the lamp".

  _buildCamPreview() {
    const el = document.createElement('div');
    el.id = 'campreview';
    el.hidden = true;
    el.innerHTML = `
      <canvas class="campreview__view" width="192" height="144"></canvas>
      <div class="campreview__status" data-cam-status></div>
    `;
    document.body.appendChild(el);
    this.camPreview = el;
    this.camCanvas = el.querySelector('canvas');
    this.camStatus = el.querySelector('[data-cam-status]');
  }

  // `tracker` is a PaddleTracker, or null to put the preview away.
  showCamPreview(tracker) {
    if (!tracker) {
      this.camPreview.hidden = true;
      return null;
    }
    this.camPreview.hidden = false;
    tracker.attachDebugCanvas(this.camCanvas);
    return this.camCanvas;
  }

  setCamStatus(text) {
    if (this.camStatus) this.camStatus.textContent = text;
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

    if (mode === 'tournament') {
      this.bar.querySelector('[data-bar-mode]').textContent = 'Tournament';
      this.bar.querySelector('[data-bar-stats]').textContent = 'real bracket · no simulated results';
      this.bar.querySelector('[data-toggle-label]').textContent = 'Pause';
      return;
    }

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
