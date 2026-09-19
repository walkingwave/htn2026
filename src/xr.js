// WebXR session management, kept separate from the UI that triggers it.
//
// Three's stock VRButton/ARButton each own both the session logic and their
// own DOM, and each handles a single mode. We need two modes driven from our
// own menu, so the session half lives here and the presentation half lives
// in ui.js.

const SESSION_INIT = {
  'immersive-ar': {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['hand-tracking', 'hit-test'],
  },
  'immersive-vr': {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['hand-tracking'],
  },
};

export class XRManager {
  constructor(renderer) {
    this.renderer = renderer;
    this.session = null;
    this.mode = null;
    this.support = { 'immersive-ar': false, 'immersive-vr': false };

    this.onModeChange = null; // (mode | null)
  }

  // Resolves once both modes have been probed, so the menu can render its
  // buttons in their final enabled/disabled state rather than flickering.
  async detectSupport() {
    if (!('xr' in navigator)) return this.support;
    await Promise.all(
      Object.keys(SESSION_INIT).map(async (mode) => {
        this.support[mode] = await navigator.xr
          .isSessionSupported(mode)
          .catch(() => false);
      })
    );
    return this.support;
  }

  get available() {
    return this.support['immersive-ar'] || this.support['immersive-vr'];
  }

  async start(mode) {
    if (this.session) return;

    const session = await navigator.xr.requestSession(mode, SESSION_INIT[mode]);
    this.session = session;
    this.mode = mode;

    session.addEventListener('end', () => {
      this.session = null;
      this.mode = null;
      this.onModeChange?.(null);
    });

    // Fire before handing the session to three so the scene is already
    // configured for the mode on its very first rendered frame.
    this.onModeChange?.(mode);
    await this.renderer.xr.setSession(session);
  }

  end() {
    this.session?.end();
  }
}
