// encodeBefore reproduces Effect rc.115's character concatenation for the memory comparison.
export default function encodeBefore(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  const length = bytes.length
  let result = ""
  let i
  for (i = 2; i < length; i += 3) {
    result += alphabet[bytes[i - 2] >> 2]
    result += alphabet[((bytes[i - 2] & 3) << 4) | (bytes[i - 1] >> 4)]
    result += alphabet[((bytes[i - 1] & 15) << 2) | (bytes[i] >> 6)]
    result += alphabet[bytes[i] & 63]
  }
  if (i === length + 1) {
    result += alphabet[bytes[i - 2] >> 2]
    result += alphabet[(bytes[i - 2] & 3) << 4]
    result += "=="
  }
  if (i === length) {
    result += alphabet[bytes[i - 2] >> 2]
    result += alphabet[((bytes[i - 2] & 3) << 4) | (bytes[i - 1] >> 4)]
    result += alphabet[(bytes[i - 1] & 15) << 2]
    result += "="
  }
  return result
}
