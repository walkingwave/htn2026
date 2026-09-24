import { createPhonePairRoom, makeRoomCode } from '../net.js';
import { TRACKER_STATE } from '../vision/trackerState.js';

// Phone paddle pairing.
//
// A phone drives aim over the same tiny relay Versus uses, but its room is
// separate so a phone can steer a solo drill without turning that drill into a
// networked match. The desktop's own camera closes the loop: it watches the
// marker board and turns the phone's physical position into the paddle's
// location, while the phone's IMU owns orientation.
//
// All of it is one session's state — which room is open, whether the phone has
// said hello, whether CV has locked — so it lives together and main.js only
// reads the pose out of it.
//
// @param {object} options
// @param {import('../ui.js').UI} options.ui
// @param {() => Promise<{ MarkerPaddleTracker: any }>} options.loadTracker
//   lazy loader for the marker tracker (shared with the webcam bat, so the
//   module is only fetched once).
// @param {() => void} [options.onStop]  called whenever CV stops, so the caller
//   can drop any aim state it derived from the tracker.
export function createPhonePair({ ui, loadTracker, onStop }) {
  let room = null;
  let pairLink = '';
  let connected = false;
  let confirmed = false;
  let cvLocked = false;
  let aimAssistActive = false;
  let aimLockTime = 0;
  let lastPose = null;
  let tracker = null;
  let cvLoading = false;

  function maybeReady() {
    if (confirmed && cvLocked) ui.phoneReady();
  }

  async function startCv() {
    if (tracker || cvLoading) return;
    cvLoading = true;
    let MarkerPaddleTracker;
    try {
      ({ MarkerPaddleTracker } = await loadTracker());
      // The pair may have been closed while the module was in flight.
      if (!room || tracker) return;
      tracker = new MarkerPaddleTracker({ assistOnly: true });
    } catch (error) {
      tracker = null;
      cvLocked = false;
      ui.phoneCvWaiting();
      ui.toast(error?.message ?? 'Phone CV is unavailable in this browser');
      return;
    } finally {
      cvLoading = false;
    }
    tracker.onState = (state, error) => {
      if (state === TRACKER_STATE.TRACKING) {
        cvLocked = true;
        room?.send('phone-cv-status', { locked: true });
        ui.phoneCvReady();
        maybeReady();
      } else if (state === TRACKER_STATE.LOST || state === TRACKER_STATE.ERROR) {
        cvLocked = false;
        room?.send('phone-cv-status', { locked: false, error: error ?? null });
        ui.phoneCvWaiting();
      }
    };
    ui.showCamPreview(tracker);
    tracker.start().catch((error) => {
      cvLocked = false;
      ui.phoneCvWaiting();
      ui.toast(error?.message ?? 'Desktop camera is required for phone location');
    });
  }

  function stopCv() {
    tracker?.stop();
    tracker = null;
    aimAssistActive = false;
    aimLockTime = 0;
    onStop?.();
  }

  async function open() {
    if (room && pairLink) return { code: room.code, link: pairLink };
    const code = makeRoomCode();
    // Hybrid transport: WS for LAN (fast) + Supabase for internet (reliable).
    // Phone can now connect over any Wi-Fi / cellular without the laptop's LAN IP.
    const candidate = createPhonePairRoom({ code });
    room = candidate;
    pairLink = '';
    // Start camera in parallel so CV is warming up while the room handshakes.
    startCv();

    room.on('phone-hello', (payload) => {
      if (!payload?.ready) {
        // Any hello with motion permission still counts as the phone being present
        if (payload?.permission) connected = true;
        return;
      }
      confirmed = true;
      connected = true;
      maybeReady();
    });
    room.on('phone-calibrate', () => {
      // Phone calibrated — reflect instantly on desktop status
      ui.setPhoneStatus('Phone calibrated — hold markers to the camera and confirm', '');
    });
    room.on('phone-cv-status', ({ locked } = {}) => {
      cvLocked = Boolean(locked);
      if (cvLocked) ui.phoneCvReady();
      else ui.phoneCvWaiting();
      maybeReady();
    });
    room.on('phone-pose', (pose) => {
      if (!pose || !Number.isFinite(pose.x) || !Number.isFinite(pose.y)) return;
      connected = true;
      if (lastPose === null) {
        ui.setPhoneStatus('Phone connected — tilt to test aim, then confirm on phone', 'good');
      }
      lastPose = { ...pose };
    });
    room.onOpponent((present) => {
      connected = present;
      if (present) {
        room?.send('phone-cv-status', { locked: cvLocked });
        if (!cvLocked) ui.phoneCvWaiting();
        ui.setPhoneStatus('Phone linked — enable motion on phone, then hold markers to camera', 'good');
      } else {
        lastPose = null;
        confirmed = false;
        if (room) ui.phoneDisconnected();
      }
    });
    room.onClosed(() => {
      connected = false;
      lastPose = null;
    });

    try {
      await room.connect();
      // Prefer internet URL when Supabase is available so the phone works
      // off-LAN; fall back to LAN IP only for pure WS (dev/local) builds.
      const origin = room.kind === 'supabase' || room.kind === 'hybrid'
        ? window.location.origin
        : room.lanUrls?.[0] || window.location.origin;
      const linkUrl = new URL(origin);
      linkUrl.search = '';
      linkUrl.searchParams.set('phone', code);
      pairLink = linkUrl.toString();
      return { code, link: pairLink };
    } catch (error) {
      room.close();
      room = null;
      pairLink = '';
      stopCv();
      throw error;
    }
  }

  function close() {
    stopCv();
    room?.close();
    room = null;
    pairLink = '';
    connected = false;
    confirmed = false;
    cvLocked = false;
    lastPose = null;
  }

  // A short buzz on the phone when the desktop wants to say something without
  // looking at it — currently the serve.
  function haptic() {
    room?.send('phone-haptic', { duration: 42 });
  }

  return {
    open,
    close,
    haptic,
    startCv,
    stopCv,
    /** The phone's last orientation packet, or null. */
    get lastPose() {
      return lastPose;
    },
    set lastPose(value) {
      lastPose = value;
    },
    /** The desktop's marker tracker, once CV has started. */
    get tracker() {
      return tracker;
    },
    /** CV sees enough of the marker board to trust the measured position. */
    get identified() {
      return (
        tracker?.state === TRACKER_STATE.TRACKING &&
        tracker.markerCount >= 2 &&
        tracker.confidence >= 0.65
      );
    },
    get connected() {
      return connected;
    },
    get confirmed() {
      return confirmed;
    },
    get aimAssistActive() {
      return aimAssistActive;
    },
    set aimAssistActive(value) {
      aimAssistActive = Boolean(value);
    },
    get aimLockTime() {
      return aimLockTime;
    },
    set aimLockTime(value) {
      aimLockTime = value;
    },
  };
}
