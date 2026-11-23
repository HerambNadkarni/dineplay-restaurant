export function createTableQrLinks(value) {
  const input = value.trim()
  if (!input) throw new Error('Enter a public app URL.')

  let base
  try {
    base = new URL(input)
  } catch {
    throw new Error('Enter a complete public URL, including https:// or http://.')
  }
  if (!['http:', 'https:'].includes(base.protocol)) {
    throw new Error('Use an http:// or https:// app URL.')
  }
  if (base.search || base.hash) {
    throw new Error('The app URL cannot include a query string or fragment.')
  }

  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`
  return Array.from({ length: 10 }, (_, index) => {
    const table = String(index + 1).padStart(2, '0')
    const link = new URL(base.href)
    link.searchParams.set('table', table)
    return { table, link: link.href }
  })
}
