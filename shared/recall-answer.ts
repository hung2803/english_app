/** Ignore display punctuation for phrases, while preserving word order and contractions. */
export function sameRecall(typed: string, expected: string): boolean {
  const phrase = expected.trim().split(/\s+/).length > 1
  const normalize = (text: string) => {
    let value = text.replace(/[’‘]/g, "'").trim().toLowerCase()
    if (phrase) value = value.replace(/[.,!?;:"“”()]/g, '')
    return value.replace(/\s+/g, ' ').trim()
  }
  return normalize(typed) === normalize(expected)
}

export function shuffledRecallWords(text: string): string[] {
  const words = text.trim().split(/\s+/).map(w => w.replace(/^[.,!?;:"“”()]+|[.,!?;:"“”()]+$/g, ''))
  const mixed = [...words]
  for (let i = mixed.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[mixed[i], mixed[j]] = [mixed[j], mixed[i]]
  }
  if (mixed.length > 1 && mixed.join(' ') === words.join(' ')) mixed.push(mixed.shift()!)
  return mixed
}
