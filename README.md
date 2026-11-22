# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/zavonlame/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/zavonlame/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in for make.fun's own makefun-site 1.0.0: `solve.js` returns exactly the output tree makefun-site returns for every site, byte for byte, but faster — templates are compiled once per case into plain JavaScript functions, Markdown renders in one fused pass, inline HTML escaping works on whole runs instead of one character at a time, and slugs are memoised inside each run. Nothing is cached from one case to the next. Plain JavaScript, no dependencies, no WebAssembly.

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<dir for answers.json> node main.ts
```

`main.ts` reads every case from `cases.json`, answers each one alone with `run()` from `solve.js`, and writes `answers.json`.

<sub>Entered on [make.fun](https://make.fun/?ref=ye09dzcs&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
