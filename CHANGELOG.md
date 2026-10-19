# Changelog

## [0.6.1](https://github.com/9087/dsh-shell-progress/compare/v0.6.0...v0.6.1) (2026-10-19)

### Bug Fixes

* **tools:** make the description carry the reason to prefer this tool ([c5a78e6](https://github.com/9087/dsh-shell-progress/commit/c5a78e6cbbf6f5ac381d559ed12ce7ed5cabe023))

## [0.6.0](https://github.com/9087/dsh-shell-progress/compare/v0.5.0...v0.6.0) (2026-10-18)

### Features

* let PowerShell's parser decide where a step starts ([86e597d](https://github.com/9087/dsh-shell-progress/commit/86e597dd0d542929ff7d643304ffd5e69abf4fb6))
* **notes:** fetch a missed note on demand instead of holding the turn ([f1e2829](https://github.com/9087/dsh-shell-progress/commit/f1e2829f2e759e7c85ab8bf74a20062340316996))
* show the command's total time in the card header. ([79adb82](https://github.com/9087/dsh-shell-progress/commit/79adb827e77ac23b989c950a9326f0c6c283e076))
* split a one-line ";" chain into steps, and wrap a long one readably ([6ef0deb](https://github.com/9087/dsh-shell-progress/commit/6ef0debf7cf392b8ba8750ee44bcf692e6bbf141))

### Bug Fixes

* **notes:** ask for no thinking, read only visible text, and say why a note is missing ([06a72b3](https://github.com/9087/dsh-shell-progress/commit/06a72b328336396a0c905ea3cd290126eb6050d2))

## [0.5.0](https://github.com/9087/dsh-shell-progress/compare/v0.4.2...v0.5.0) (2026-10-17)

### Features

* **ui:** draw a refused command as one step, with a warning glyph ([ff1e14c](https://github.com/9087/dsh-shell-progress/commit/ff1e14ccb9c076ec80c3dbe892cced4ac0f3fcfd))
* **ui:** say why a command was not split, in the warning's tooltip ([20d2d12](https://github.com/9087/dsh-shell-progress/commit/20d2d12a974d5925c17cb413c8ed724e5aafd57c))

### Bug Fixes

* **notes:** give the model a moment to answer before the card freezes ([8ebc93b](https://github.com/9087/dsh-shell-progress/commit/8ebc93bb4803cda58e5f9defa6a6a6ed4679c03a))
* **notes:** one language per answer, and command strings verbatim ([c1847c7](https://github.com/9087/dsh-shell-progress/commit/c1847c71fdf4dbb87791356a777663bd6c9802de))
* **ui:** start a refused card's command on the title's column ([b7a121f](https://github.com/9087/dsh-shell-progress/commit/b7a121fa8af5a60bec8c22b6f5b02482f24b75bf))

## [0.4.2](https://github.com/9087/dsh-shell-progress/compare/v0.4.1...v0.4.2) (2026-10-16)

### Bug Fixes

* **notes:** pair the answer to steps by line number, and stop it restating the code ([d47828d](https://github.com/9087/dsh-shell-progress/commit/d47828da455eec6376fed4fd8c13becb81992c9d))

## [0.4.1](https://github.com/9087/dsh-shell-progress/compare/v0.4.0...v0.4.1) (2026-10-16)

### Bug Fixes

* **release:** count only the tool views in the published-bundle check ([78ff532](https://github.com/9087/dsh-shell-progress/commit/78ff5320548eb21f6e35b6a859ee1da6b1e4349d))

## [0.4.0](https://github.com/9087/dsh-shell-progress/compare/v0.3.0...v0.4.0) (2026-10-16)

### Features

* **client:** calm the palette, thin the bar, and keep the closed card out of the shell scroll range ([37b2e6a](https://github.com/9087/dsh-shell-progress/commit/37b2e6af45e80e91b2db6b65229c7fe176c7897b))
* **client:** degrade a refused call to the plain card ([1b5455d](https://github.com/9087/dsh-shell-progress/commit/1b5455dd576051fd9df28442cdc6c09604891c3b))
* **client:** keep the step elapsed time out of a selection ([5c5b388](https://github.com/9087/dsh-shell-progress/commit/5c5b38840bd92da1c026120c59e2113f4ce5a447))
* **client:** use the shell own wording for an omitted tail ([a457f46](https://github.com/9087/dsh-shell-progress/commit/a457f46810efac2a82f50d8dc3d1f597e33f8d9d))
* **notes:** ask for the notes beside the run, in the language the client pushed ([4026415](https://github.com/9087/dsh-shell-progress/commit/4026415c42ebf52cf33e6f55a75501d2df3ad08e))
* **notes:** ask the model for one line per command, and stay silent on any failure ([8c54ae2](https://github.com/9087/dsh-shell-progress/commit/8c54ae2565d3a562aa4554d3a2a105f2fb02de91))
* **notes:** carry a per-step note through the recorded meta ([ef7026b](https://github.com/9087/dsh-shell-progress/commit/ef7026b109943b573c61417a6aad9719c0eeb8fe))
* **notes:** draw the model line as a comment above the command in the hover card ([f60c785](https://github.com/9087/dsh-shell-progress/commit/f60c785b2f7fe01cd4a404b1d213ae7421bee755))
* **notes:** give the switch a home in DSH Settings ([d0debb6](https://github.com/9087/dsh-shell-progress/commit/d0debb6f69d49b21149b4dcea54401a1df877e51))
* **notes:** let the client tell the host the language, over the progress channel ([1c457a0](https://github.com/9087/dsh-shell-progress/commit/1c457a0d681e421c1ba5f4ef75fbb93afea5dfe1))

### Bug Fixes

* **client:** carry the model note through the live snapshot ([5d7c273](https://github.com/9087/dsh-shell-progress/commit/5d7c273da89716735398aab77a27094e80c0f344))
* **client:** give the step list one line rhythm ([68c80f0](https://github.com/9087/dsh-shell-progress/commit/68c80f010beb971faa4c3fcae74e9c9816cf3bdb))
* **client:** label the settings tab through the shell translator ([694fd90](https://github.com/9087/dsh-shell-progress/commit/694fd90bde26c87018187f7833d89cbc5d5d2da7))
* **client:** read the active language off the locale snapshot ([1ebba5f](https://github.com/9087/dsh-shell-progress/commit/1ebba5f2d9b6a7af0087ab9051431e82273b61be))
* **notes:** say WHY no note was written, once per reason ([b401af1](https://github.com/9087/dsh-shell-progress/commit/b401af11d018c1a587f704d6b67e7d2aad4e97c8))
* **release:** give the verification gate ten minutes to see a fresh publish ([d791689](https://github.com/9087/dsh-shell-progress/commit/d791689c15cf5986e2c3f6c1380d29d9f10dc61e))
* **release:** make the publish idempotent and recover a verification timeout ([724ff39](https://github.com/9087/dsh-shell-progress/commit/724ff399b37de29b3e5e3d32ad09310420b90f17))

## [0.3.0](https://github.com/9087/dsh-shell-progress/compare/v0.2.0...v0.3.0) (2026-10-16)

### Features

* **client:** state how much of a truncated step's output is missing ([563f328](https://github.com/9087/dsh-shell-progress/commit/563f328e45965806e2cb6c46983a212162b64e53))
* **release:** verify the published artifact, not just the source ([23d196b](https://github.com/9087/dsh-shell-progress/commit/23d196b3695f2feebde1b5125b75d414fa8f7c72))

### Bug Fixes

* **client:** give a single-step command its one segment, and stop fading unrun lines ([52f5f75](https://github.com/9087/dsh-shell-progress/commit/52f5f75cb9b3568027cfa99f170b6f48fad7a03f))

## [0.2.0](https://github.com/9087/dsh-shell-progress/compare/v0.1.1...v0.2.0) (2026-10-15)

### Features

* **client:** open a real hover card on a segment, and calm the bar ([34415f5](https://github.com/9087/dsh-shell-progress/commit/34415f5b9dad20cca7c4a2e3f2fa312ac236ae85))
* plan steps with each shell's own parser, and refuse instead of guessing ([c47d94c](https://github.com/9087/dsh-shell-progress/commit/c47d94cba0a4fa91194f9cac902a00fbee219647))

### Bug Fixes

* **client:** align the progress line with the list, and stop padding empty output ([ce52c42](https://github.com/9087/dsh-shell-progress/commit/ce52c42d80d5a828570dce298db3c08a19cbd857))

## [0.1.1](https://github.com/9087/dsh-shell-progress/compare/v0.1.0...v0.1.1) (2026-10-14)

### Bug Fixes

* **tools:** make the plugin tool the default, not a multi-line exception ([4233871](https://github.com/9087/dsh-shell-progress/commit/4233871b7308c337915b3b257fd149bd80895d36))
* **ui:** put the caret on the first line and the clock beside the command ([cdc9fe9](https://github.com/9087/dsh-shell-progress/commit/cdc9fe9c6fe4b8e8ac264c8318f916d18eab4deb))

Generated by `release-it` from conventional commits. Do not hand-write entries.
