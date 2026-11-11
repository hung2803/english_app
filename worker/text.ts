/** Giữ tối đa `max` từ đầu tiên (từ = chuỗi cách nhau bởi khoảng trắng). Dùng để giới hạn đoạn trích từ nguồn. */
export function clipWords(s: string, max: number): string {
  const words = s.trim().split(/\s+/).filter(Boolean)
  return words.length <= max ? words.join(' ') : words.slice(0, max).join(' ')
}

export const countWords = (s: string) => s.trim().split(/\s+/).filter(Boolean).length
