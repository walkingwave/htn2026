const params = new URLSearchParams(window.location.search);
const phoneCode = params.get('phone');
const poseCode = params.get('pose');

if (phoneCode) {
  import('./phone.js');
} else if (poseCode) {
  import('./phonePose.js')
    .then(({ PhonePoseCompanion }) => new PhonePoseCompanion(poseCode).start())
    .catch((error) => {
      document.body.textContent = error?.message || 'The phone camera companion could not start.';
    });
} else {
  import('./main.js');
}
