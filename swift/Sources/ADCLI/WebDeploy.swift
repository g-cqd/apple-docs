// `ad-cli web deploy [platform]` — print per-platform static-hosting instructions
// (the config-guidance half of cli.js's `web` verb; `web build` is the real build,
// `web serve` is the native ad-server). Pure stdout, no corpus. Ports
// src/commands/web-deploy.js's INSTRUCTIONS table 1:1.

import ADJSONCore
import ArgumentParser
import Foundation

/// The supported platforms IN ORDER (github-pages is the default), each with its
/// numbered instruction lines. Mirrors `web-deploy.js` INSTRUCTIONS.
private let deployInstructions: [(platform: String, steps: [String])] = [
    (
        "github-pages",
        [
            "1. Push your built site to the `gh-pages` branch (or configure GitHub Pages to use `docs/` on `main`).",
            "2. Go to Settings > Pages in your GitHub repository.",
            "3. Set Source to \"Deploy from a branch\" and select `gh-pages` / `root`.",
            "4. Run: apple-docs web build --base-url https://<user>.github.io/<repo>",
            "5. Copy the contents of dist/web/ to your gh-pages branch and push.",
            "6. GitHub Actions example: use `peaceiris/actions-gh-pages` to automate deployment."
        ]
    ),
    (
        "cloudflare",
        [
            "1. Log in to the Cloudflare dashboard and go to Pages.",
            "2. Click \"Create a project\" and connect your Git repository.",
            "3. Set the build command to: apple-docs web build",
            "4. Set the build output directory to: dist/web",
            "5. Add environment variable BASE_URL with your Cloudflare Pages domain.",
            "6. Deploy — Cloudflare Pages will rebuild on every push to your default branch."
        ]
    ),
    (
        "vercel",
        [
            "1. Install the Vercel CLI: npm i -g vercel",
            "2. Run: apple-docs web build --out dist/web",
            "3. Run: vercel deploy --prebuilt dist/web",
            "4. For production: vercel deploy --prod --prebuilt dist/web",
            "5. Or connect your Git repo at vercel.com for automatic deployments.",
            "6. Set the output directory to dist/web in your Vercel project settings."
        ]
    ),
    (
        "netlify",
        [
            "1. Install the Netlify CLI: npm i -g netlify-cli",
            "2. Run: apple-docs web build --out dist/web",
            "3. Run: netlify deploy --dir dist/web",
            "4. For production: netlify deploy --prod --dir dist/web",
            "5. Or connect your Git repo at netlify.com for automatic deployments.",
            "6. Set publish directory to dist/web in your Netlify site settings."
        ]
    )
]

/// `ad-cli web deploy [<platform>] [--json]`.
struct WebDeployCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "deploy", abstract: "Print static-hosting deployment instructions.")

    @Argument(help: "Target platform: github-pages (default), cloudflare, vercel, netlify.")
    var platform: String = "github-pages"

    @Flag(name: .long, help: "Emit JSON instead of the human listing.")
    var json = false

    func run() throws {
        guard let entry = deployInstructions.first(where: { $0.platform == platform }) else {
            let supported = deployInstructions.map(\.platform).joined(separator: ", ")
            FileHandle.standardError.write(
                Data("Error: Unknown platform: \"\(platform)\". Supported platforms: \(supported)\n".utf8))
            throw ExitCode(1)
        }
        if json {
            print(
                stringifyPretty(
                    .obj([
                        ("platform", .string(entry.platform)),
                        ("instructions", .array(entry.steps.map(JSONValue.string)))
                    ])))
        } else {
            var lines = ["Deploy to \(entry.platform):", ""]
            lines.append(contentsOf: entry.steps)
            print(lines.joined(separator: "\n"))
        }
    }
}
