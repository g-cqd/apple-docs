export function sha256(data) {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex')
}
