# Caption Glossary

Projects with captions can provide `01_intent/caption_glossary.yaml`. The
caption command loads it before segmentation and line breaking, so canonical
names are already correct when captions are split and rendered.

```yaml
version: "1"
project_names: ["Active Listening Talks vol.5"]
brand_terms: ["Lively", "LivelyTalk"]
terms:
  - canonical: "精神科医Tomy"
    variants: ["精神科医トミー", "精神科医のトミン"]
  - canonical: "岡えり"
    variants: ["岡入り", "岡井"]
corrections:
  - from: "アクティブレスニングトークス"
    to: "Active Listening Talks"
```

Before transcription or caption approval, ask for the official spellings of:

1. event, company, product, and service names;
2. speaker names, titles, and preferred honorifics;
3. book titles, coined terms, and technical terminology;
4. known ASR misrecognitions and their replacements.

`terms[].variants` and `corrections` are project-local deterministic
replacements. Longer variants run first. The canonical values are also passed
to the optional LLM caption editor as protected glossary terms. When the file
is absent, caption generation remains backward compatible and does not invent
spellings.
