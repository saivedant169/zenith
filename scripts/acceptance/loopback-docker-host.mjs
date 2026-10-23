// PROD-UX-01 plugin-platform lane, test processes only (node --import). The Mac host does not resolve the
// Docker Desktop name host.docker.internal; this maps exactly that one name to loopback, as an /etc/hosts line
// would. Certificates are still verified against the name. Every other name resolves normally.
import dns from 'node:dns';
const NAME = 'host.docker.internal';
const original = dns.lookup;
dns.lookup = function lookup(hostname, options, callback) {
  if (String(hostname).toLowerCase() !== NAME) return original.call(this, hostname, options, callback);
  const cb = typeof options === 'function' ? options : callback;
  const all = typeof options === 'object' && options?.all;
  process.nextTick(() => all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));
};
const promised = dns.promises.lookup;
dns.promises.lookup = async (hostname, options) => String(hostname).toLowerCase() === NAME
  ? (typeof options === 'object' && options?.all ? [{ address: '127.0.0.1', family: 4 }] : { address: '127.0.0.1', family: 4 })
  : promised(hostname, options);
