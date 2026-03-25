I want to build a pdf editing software similar to pdfgear, but accessible as a webapp. The core pdf manipulation should be implemented in a rust SDK. This SDK should be used to handle the heavy lifting with respect the actual pdf manipulation tasks. It should then get used in the webapp to power its feature by compiling down to WASM and directly embedding locally. Eventually, the SDK should also be useable through a CLI interface as well, but we will leave that to a subsequent phase. I mention here only to inform you with your initial architecture search.. To start, I want to deep research an initial plan to scaffold this project. PDFGear has a ton of features. I want to start with implementing some core PDF features such as:

1. Opening and Viewing PDFs
2. Saving PDFs
3. Merging PDFs
4. Splitting PDFs
5. Compressing PDFs

Please start by researching existing open source libraries that could be used as inspiration for this project. I want to re-implement the core PDF handling in Rust. Please deep research what webapp stack we should use, I am highly leaning towards using Astro framework. I would like to compile the PDF rust SDK into an WASM module and embed in the webapp avoiding the need to store or process anything server side and avoding any need for a full fledged API.

Lets start by deep researching this space and documenting everything you can learn about this project. Include research into limitations for compiling rust code into a wasm module, as well as, integrating wasm modules into Astro (and other web frameworks).