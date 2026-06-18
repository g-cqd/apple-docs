import HTTPTypes
import Testing

@testable import ADServeCore
@testable import ADServeDSL

private func sampleTable() -> any HTTPHandling {
    let apps = Server {
        App(pool: .none) {
            GET("healthz", pool: .none) { _ in .plain(.ok, "ok") }.cache(.noStore)
            Group("api") {
                GET("filters", pool: .none) { _ in .plain(.ok, "f") }.etag
            }
            POST("mcp", pool: .none) { _ in .plain(.ok, "m") }
        }
    }
    return listeners(apps, defaultPort: 8080)[0].routes
}

private func match(_ t: any HTTPHandling, _ method: HTTPRequest.Method, _ path: String) -> RouteMatch {
    t.match(method: method, path: path[...])
}

@Suite struct RouteMatchTests {
    @Test func exactAndGroupedPathsMatch() {
        let t = sampleTable()
        #expect(isMatched(match(t, .get, "/healthz")))
        #expect(isMatched(match(t, .get, "/api/filters")))
        #expect(isMatched(match(t, .post, "/mcp")))
    }

    @Test func methodMismatchIs405() {
        if case .methodNotAllowed = match(sampleTable(), .get, "/mcp") {
        } else {
            Issue.record("expected methodNotAllowed for GET /mcp")
        }
    }

    @Test func unknownPathIs404() {
        if case .notFound = match(sampleTable(), .get, "/nope") {
        } else {
            Issue.record("expected notFound for GET /nope")
        }
    }

    @Test func cachePolicyIsCarried() {
        guard case .matched(let health) = match(sampleTable(), .get, "/healthz") else {
            Issue.record("expected match")
            return
        }
        #expect(health.cache.cacheControl == "no-store")
        #expect(health.needsStorage == false)

        guard case .matched(let filters) = match(sampleTable(), .get, "/api/filters") else {
            Issue.record("expected match")
            return
        }
        #expect(filters.cache.etag)
    }

    private func isMatched(_ m: RouteMatch) -> Bool {
        if case .matched = m { return true }
        return false
    }
}
