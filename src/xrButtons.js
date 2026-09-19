// Two-mode XR entry UI: "Enter AR" (passthrough) and "Enter VR".
// Three's stock VRButton/ARButton each handle a single mode, so this builds
// both buttons, checks support for each, and reports which mode started.

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

export function createXRButtons(renderer, { onModeChange } = {}) {
  const container = document.createElement('div');
  container.dataset.flyballXr = 'true';
  Object.assign(container.style, {
    position: 'absolute',
    bottom: '20px',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    gap: '12px',
    zIndex: '2',
  });

  let currentSession = null;
  let currentMode = null;

  const makeButton = (label) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    Object.assign(btn.style, {
      padding: '12px 24px',
      border: '1px solid #fff',
      borderRadius: '6px',
      background: 'rgba(0,0,0,0.6)',
      color: '#fff',
      font: '600 14px system-ui, sans-serif',
      cursor: 'pointer',
      opacity: '0.9',
    });
    btn.onmouseenter = () => (btn.style.opacity = '1');
    btn.onmouseleave = () => (btn.style.opacity = '0.9');
    container.appendChild(btn);
    return btn;
  };

  const arButton = makeButton('Enter AR');
  const vrButton = makeButton('Enter VR');
  const buttons = { 'immersive-ar': arButton, 'immersive-vr': vrButton };

  const onSessionEnded = () => {
    currentSession.removeEventListener('end', onSessionEnded);
    buttons[currentMode].textContent =
      currentMode === 'immersive-ar' ? 'Enter AR' : 'Enter VR';
    currentSession = null;
    currentMode = null;
  };

  const toggleSession = async (mode) => {
    if (currentSession) {
      currentSession.end();
      return;
    }
    const session = await navigator.xr.requestSession(mode, SESSION_INIT[mode]);
    session.addEventListener('end', onSessionEnded);
    currentSession = session;
    currentMode = mode;
    buttons[mode].textContent = 'Exit';
    onModeChange?.(mode); // fire before setSession so scene is ready at first frame
    await renderer.xr.setSession(session);
  };

  const setupButton = async (mode) => {
    const btn = buttons[mode];
    if (!('xr' in navigator)) {
      btn.disabled = true;
      btn.textContent = 'WebXR N/A';
      btn.style.opacity = '0.4';
      return false;
    }
    const supported = await navigator.xr
      .isSessionSupported(mode)
      .catch(() => false);
    if (!supported) {
      btn.disabled = true;
      btn.style.opacity = '0.4';
      btn.textContent = mode === 'immersive-ar' ? 'AR N/A' : 'VR N/A';
      return false;
    }
    btn.onclick = () => toggleSession(mode).catch(console.error);
    return true;
  };

  Promise.all([setupButton('immersive-ar'), setupButton('immersive-vr')]).then((supported) => {
    if (!supported.some(Boolean)) container.style.display = 'none';
  });

  document.body.appendChild(container);
  return container;
}
