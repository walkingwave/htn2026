import base from './vite.config.js';
const r = typeof base === 'function' ? base({mode:'development',command:'serve'}) : base;
export default { ...r, plugins: r.plugins.filter(p => p?.name !== 'vite:basic-ssl'), server: { ...r.server, port: 5199, https: false } };
