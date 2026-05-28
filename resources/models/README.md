# Local transcription models

Development builds do not need a model here. If no local model is found, Cereal lets
WhisperKit download and cache `large-v3-v20240930_626MB` on first transcription use.

For a release build that should work offline on first launch, place a complete
WhisperKit Core ML model directory at:

```text
resources/models/whisper-large-v3/
```

`electron-builder` copies this directory into `Contents/Resources/models/` when
building the app. Model files are intentionally gitignored.
