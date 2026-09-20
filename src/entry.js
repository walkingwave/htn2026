const isPhone = new URLSearchParams(window.location.search).has('phone');
if (isPhone) import('./phone.js');
else import('./main.js');
