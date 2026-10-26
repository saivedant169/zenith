import { createHmac } from 'node:crypto';

/** Disposable operator's actual Auth-issued setup key, held in memory only. */
export function totp(secret, now = Date.now()) {
  if (!/^[A-Z2-7]+$/.test(secret) || !Number.isFinite(now) || now < 0) throw new Error('journey:mfa-key');
  const bits = [...secret].map(char => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map(byte => parseInt(byte, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}

export async function enrollOperator(page, stack) {
  await page.goto(stack.apiUrl + '/account/mfa/enrol?next=/overview');
  await page.getByRole('button', { name: 'Set up authenticator', exact: true }).click();
  const setupKey = page.getByLabel('Setup key', { exact: true });
  await setupKey.waitFor();
  const secret = await setupKey.inputValue();
  // Avoid submitting a code at the end of its period, without changing Auth's clock.
  if (Date.now() % 30000 > 27000) await page.waitForTimeout(3100);
  await page.getByLabel('Six-digit authenticator code', { exact: true }).fill(totp(secret));
  await page.getByRole('button', { name: 'Verify authenticator', exact: true }).click();
  await page.getByRole('heading', { name: 'Authenticator verified', exact: true }).waitFor();
  const proof = await page.evaluate(async () => {
    const response = await fetch('/api/auth/mfa/verify', { credentials: 'same-origin' });
    return response.ok && (await response.json()).verified === true;
  });
  if (!proof) throw new Error('journey:mfa-server-proof');
  await page.getByRole('link', { name: 'Return to review', exact: true }).click();
  return secret;
}
