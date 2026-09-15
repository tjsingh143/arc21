# Refresh A dependency disposition

Reconciled September 14, 2026 after compatible security patches.
`dependency-audit-september14.json` in the durable September 11 evidence directory
reports **18 affected package entries: 14 moderate and 4 high, representing four
distinct advisories**. The September 12 pre-update result (23 entries / 18
advisories) is retained. Parent dependency chains repeat advisories; this is
not a clean npm audit. Compatible Expo SDK patches were subsequently aligned to
Doctor's required versions; React Native remains 0.86.3. The final feed retains
the same four advisories after that alignment.

## Runtime and build boundaries

| Installed dependency | Advisory and relevant behavior | Arc 21 disposition |
| --- | --- | --- |
| `decode-uri-component@0.2.2`, via `query-string@7.1.3` and Expo Router | Malformed percent encoding can consume excessive CPU in the fallback decoder; fixed in 0.5.0. [Maintainer advisory](https://github.com/SamVerschueren/decode-uri-component/security/advisories/GHSA-vcc3-ghjq-m6fr). | The vulnerable function **is bundled**. Expo's active inbound-link resolver uses its fork, `URLSearchParams`, and bounded built-in decoding. The bundled upstream fallback contains the dangerous parse call but is overridden in the running navigation configuration. Active `query-string` callers construct outbound URLs. Reachability regression includes the upstream parse as a positive control. Final native malformed-link navigation passes on the installed Release; see the evidence below. |
| `image-size@1.2.1`, through Metro | Crafted ICNS, JXL or HEIF size fields can hang the parser. The two advisories list no patched version: [ICNS](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr), [JXL/HEIF](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq). | Absent from the iOS runtime bundle. Metro reads project assets during development/builds; current committed bitmap assets are PNG. The game has no image-upload or arbitrary image-parser endpoint. A malicious asset introduced into the build remains a tooling exposure. |
| `uuid@7.0.3`, via `xcode@3.0.1` | The affected v3/v5/v6 methods can silently perform partial writes to caller-provided output buffers. Patched branches include 11.1.1, 12.0.1 and 13.0.1. [Maintainer advisory](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq). | The affected npm package is absent from the runtime bundle. Xcode project generation calls `uuid.v4()` without an output buffer. The three Expo UUID helper modules in the source map are a different implementation. |

## Patched September 13

- Vitest and its coverage package now require **4.1.11**. This updates the mocker
  that had the development-server file-read finding. [Maintainer advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9).
- Transitive js-yaml is **4.3.2**, fixing the empty-merge CPU finding.
  [Maintainer advisory](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh).
- Both xmldom branches are patched to **0.8.15 / 0.9.12**, removing all twelve
  XML findings in the current feed. Their prior advisory inventory remains below.

The lockfile also advances Vitest's compatible test-tool dependencies, including
Vite 8.3.0 and Rolldown 1.2.8, plus PostCSS 8.5.28. These changes require a clean
install, current tests and a fresh build; they are not represented as preserving
the old lockfile. `dependency-vitest-update.log` and
`dependency-build-parser-update.log` preserve the installation results.

The final SDK alignment uses Expo **57.0.22**, Router **57.0.21**, and the eleven
other matching direct Expo package versions in `package.json`.
`expo-sdk-patch-review.json` compares their published contents with the prior
installation. Most direct packages change build metadata; Router adds optional
LocaleProvider/native-stack exports and native-tab icon corrections. Arc 21
continues to use Stack/Tabs. Transitive native-core/JSI, tooling, font and web
dependency updates are recorded in `expo-sdk-transitive-review.json`; they are
not represented as unchanged runtime dependencies. Doctor passes 21/21 after
alignment, and the clean current install, unit and coverage gates pass. The
fresh Release passes native storage, normal/cold navigation and malformed-link
interaction. Its matching map has been inspected.

These are findings about **this application and its current call paths**, not
claims that the vulnerable packages are safe in general. No reachable
release-blocking exploit has been established in the audited runtime paths.
The build boundary still assumes reviewed repository configuration/assets and a
trusted development environment.

## Evidence and maintenance

The earlier dependency-chain and source-map reports were under
`/tmp/arc21-astra-baseline/`, which did not survive the host restart. They are
historical evidence, not the current artifact. The current artifacts are
`final-a-release-source.json`,
`final-a-dependency-reachability.json` and `final-a-native-return.xml` under
`/Users/tj/arc21-evidence/astra-refresh-a-20260911/`. The installed bundle is
`c765bef7b87057f591cbf4525d27fa988456847da2ec7ad53434512ece8970b9`; its
matching map is `268691b7dad713f7e5297c9e62c86aa65b2017c167820d62ff59bba7170cb447`.
All 2,646 source contents were compared; the final Career BackBar is the only
change from the verified accessibility build. The dependency contents and
resolver wiring are identical. The native flow opens a 12,291-character `%FF`
query, renders Career, accepts Back and returns to Home. It establishes
responsiveness without claiming an unmeasured precise navigation time. The
earlier flow that reached Career but failed on its missing Back control is
retained separately and is not represented as passing.

`tests/deep-links/decode-uri-component-reachability.test.ts` checks the active
Expo resolver, the bounded query parser, the only installed `query-string`
consumer, and a positive control that finds the dangerous upstream call. An
Expo/linking dependency update must re-evaluate those assumptions and the native
link test. Bundling the vulnerable module is explicitly acknowledged.

Keep the advisories visible for dependency maintenance. Do not apply the audit
tool's suggested Expo major downgrades or an unverified decoder module-format
override merely to remove entries: either changes the tested application and
requires a compatibility/build review. Reassess this disposition if the product
adds remote asset ingestion, XML input, affected UUID buffer methods, or a new
inbound URL parser.

## Patched xmldom advisory inventory

All twelve affected the prior plist build dependency. Their prior severity and
installed nodes remain in the September 12 raw npm JSON; the September 13 feed
confirms that the patched versions are no longer affected. None is suppressed.

- [xmldom: DocType `name` Injection Bypasses requireWellFormed](https://github.com/advisories/GHSA-27p8-2357-5qqv)
- [xmldom: Creation-time XML Name/QName validation is bypassable via an embedded line terminator, allowing injection on the default serialization path](https://github.com/advisories/GHSA-3px3-54cx-rmw9)
- [xmldom: XML fragment injection via invalid EntityReference.nodeName during requireWellFormed serialization](https://github.com/advisories/GHSA-6gmq-8vp8-gcm6)
- [xmldom: Parser silently accepts a not-well-formed end tag whose name is followed by a line break and trailing content](https://github.com/advisories/GHSA-6h8r-xr42-gp59)
- [xmldom: HTML raw-text closing-tag case mismatch causes output amplification](https://github.com/advisories/GHSA-6mj3-qw4j-hgrw)
- [xmldom: Quadratic-time attribute deduplication](https://github.com/advisories/GHSA-8344-3jmq-59r6)
- [xmldom: Quadratic-time parsing via the malformed-input recovery path — `parseElementStartPart` re-scan and `normalize()` adjacent-text merge](https://github.com/advisories/GHSA-93r5-fhx6-vmg9)
- [xmldom: Quadratic-memory consumption](https://github.com/advisories/GHSA-965w-775f-mr7g)
- [xmldom: Processing Instruction Target Injection Bypasses requireWellFormed](https://github.com/advisories/GHSA-c7q8-3ch8-vqpv)
- [xmldom: requireWellFormed element/attribute name validation is bypassable via an embedded line terminator](https://github.com/advisories/GHSA-jxjr-3g7g-3944)
- [xmldom: requireWellFormed DocType publicId/systemId validation is bypassable via an embedded line terminator](https://github.com/advisories/GHSA-vr34-hp96-76pp)
- [xmldom: End-tag Whitespace-Trim Regex ReDoS — quadratic backtracking in the 0.8.x end-tag parser](https://github.com/advisories/GHSA-x4fp-j954-r2f4)
