# esbuild "installed for another platform" that was really a missing binary

## The problem

`npm run snapshot:local` died with esbuild's "You installed esbuild for another
platform than the one you're currently using", naming `@esbuild/darwin-arm64` as
both the package that is present AND the one needed — on a machine that is
genuinely darwin-arm64.

## The approach

1. Read the error literally instead of acting on its advice. It names the *same*
   package on both sides of "present but needs X instead". That sentence cannot
   be true, so the platform diagnosis in the message is wrong and the real
   failure is upstream of it — in esbuild's `generateBinPath`
   (`node_modules/esbuild/lib/main.js`), which falls into the platform-mismatch
   branch whenever it cannot use the binary, for *any* reason.
2. Confirmed the platform was not in fact mismatched:
   `uname -m` -> arm64, `node -p "process.platform + '/' + process.arch"` ->
   darwin/arm64, and both `esbuild` and `@esbuild/darwin-arm64` at 0.27.7.
3. Looked for the binary the resolver actually wants:
   `ls -l node_modules/@esbuild/darwin-arm64/bin/`
   It held `esbuild 2`, `esbuild 3`, `esbuild 4`, `esbuild 5`, `esbuild 6` —
   and no plain `esbuild`. Those numeric suffixes are macOS duplicate-file
   naming, not anything npm produces.
4. Used the natural control already present in the repo. `npm run test`
   (vitest) had passed minutes earlier. `find node_modules -maxdepth 4 -type d
   -name esbuild` showed a second copy at `node_modules/vite/node_modules/`,
   whose `bin/` had the real `esbuild` *plus* the same five duplicates. So
   vitest worked because vite uses its own nested esbuild 0.21.5; tsx failed
   because it uses the root esbuild 0.27.7 whose canonical file was gone.
   One toolchain broken and one working, same machine, same minute — that pair
   localises the fault to the file, not the platform.
5. Established the duplicates were the genuine binary before trusting one:
   all five byte-identical (`shasum -a 256 ... | awk '{print $1}' | sort -u`
   gave a single hash), and `file` reported `Mach-O 64-bit executable arm64`.
6. Restored the canonical name with `cp` + `chmod +x`, then verified
   `./node_modules/@esbuild/darwin-arm64/bin/esbuild --version` -> 0.27.7 and
   ran a throwaway `.ts` probe through `node node_modules/.bin/tsx` to prove
   the transform and the `@/*` path alias both work again.

The underlying cause: the repo lives in `~/Desktop`, iCloud Drive's
"Desktop & Documents" sync is on and active, and a sync pass renamed files it
considered conflicted. `node_modules/undici/LICENSE 2` was collateral from the
same event.

## The judgment calls

- **Did not run `rm -rf node_modules/@esbuild/darwin-arm64 && npm install`.**
  A targeted `cp` of a checksum-verified binary is smaller, needs no network,
  and leaves every other package untouched. A reinstall was the fallback if the
  duplicates had turned out to differ from each other.
- **Did not delete the ~100MB of leftover `* 2`..`* 6` duplicates.** They are
  inert — the breakage was the *absence* of `bin/esbuild`, not the presence of
  the copies. Deleting files a sync process created, in bulk, is the user's
  call.
- **Did not move the repo off the iCloud-synced Desktop**, which is the actual
  permanent fix. That relocates the user's working tree; recommended instead.
- **Did not verify by running `npm run snapshot:local`.** That reads the
  production database, which `.claude/rules/data-privacy.md` puts off-limits.
  Verified with a synthetic `.ts` probe that exercises the same tsx code path.

## The reusable rule

When a tool's error message is internally contradictory — naming the same thing
as both what you have and what you need — stop believing its diagnosis and go
look for the file it is actually trying to open; and when one toolchain fails
while a sibling toolchain in the same repo succeeds, diff their two dependency
copies, because that pair localises the fault faster than any amount of reading
the error.
