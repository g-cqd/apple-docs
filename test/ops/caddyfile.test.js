import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const template = readFileSync(join(import.meta.dir, '../../ops/caddy/Caddyfile.tpl'), 'utf8')

/** Text of the site block that starts at the first line containing `marker`. */
function siteBlock(marker) {
  const start = template.indexOf(marker)
  expect(start).toBeGreaterThan(-1)
  const next = template.indexOf('\nhttp://', start + marker.length)
  return template.slice(start, next === -1 ? undefined : next)
}

describe('ops/caddy/Caddyfile.tpl hardening', () => {
  test('defines a shared security-headers snippet with CSP and HSTS', () => {
    const snippet = template.slice(template.indexOf('(security_headers)'), template.indexOf('# ---', template.indexOf('(security_headers)')))
    expect(snippet).toContain('header Content-Security-Policy "${CSP_HEADER}"')
    expect(snippet).toMatch(/header Strict-Transport-Security "max-age=\d{8,}"/)
  })

  test('HSTS omits includeSubDomains and preload (other subdomains are not known to be HTTPS-only)', () => {
    expect(template).not.toMatch(/Strict-Transport-Security[^\n]*(includeSubDomains|preload)/)
  })

  test('the web vhost imports the snippet for normal and error (404) responses', () => {
    const web = siteBlock('http://${PUBLIC_WEB_HOST}')
    expect(web.match(/import security_headers/g)).toHaveLength(2)
    expect(web.indexOf('handle_errors')).toBeLessThan(web.lastIndexOf('import security_headers'))
  })

  test('the MCP vhost sends HSTS', () => {
    expect(siteBlock('http://${PUBLIC_MCP_HOST}')).toContain('Strict-Transport-Security')
  })

  test('the MCP vhost no longer keeps long-lived SSE streams open (GET /mcp answers 405)', () => {
    const mcp = siteBlock('http://${PUBLIC_MCP_HOST}')
    expect(mcp).not.toContain('stream_timeout')
    expect(mcp).not.toContain('stream_close_delay')
  })
})
