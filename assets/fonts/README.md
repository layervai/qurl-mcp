# Noto Sans SC

`NotoSansSC-Regular.ttf` is the weight-400 instance of the previously bundled
`NotoSansSC-VF.ttf`. It retains all 30,890 Unicode mappings and the original glyphs,
but removes unused variation tables. PDFKit embeds only the used glyphs.

Reproduce from `assets/fonts/NotoSansSC-VF.ttf` at commit `4049006`:

```sh
python -m pip install fonttools==4.65.0
python -m fontTools.varLib.instancer NotoSansSC-VF.ttf wght=400 --output=NotoSansSC-Regular.ttf
```

Original SHA-256: `763146584cf0710223441356b4395e279021b0806c196614377a7a0174ae074a`.
The original SIL Open Font License remains in `OFL.txt`.

Keep TrueType: fontkit's WOFF2 path inflated even a short PDF to over 25 MB in
verification. No Python/fontTools dependency is needed at runtime.
