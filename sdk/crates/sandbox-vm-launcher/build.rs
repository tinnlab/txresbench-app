fn main() {
    // libkrun is only linked on macOS.
    //
    // - Shipped runtime: `TXR_LIBKRUN_LIB_DIR` names the directory holding the libkrun the app ships
    //   (scripts/build-macos-vm-runtime.sh builds it without GPU support). The launcher links it and
    //   finds it at run time only in `../lib` next to itself (the runtime's bin/ + lib/ layout), never in
    //   Homebrew.
    // - Development: without the variable, link Homebrew's libkrun (`brew install slp/krun/libkrun`) and
    //   find it under /opt/homebrew/lib.
    println!("cargo:rerun-if-env-changed=TXR_LIBKRUN_LIB_DIR");
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-lib=dylib=krun");
        match std::env::var("TXR_LIBKRUN_LIB_DIR") {
            Ok(dir) if !dir.is_empty() => {
                println!("cargo:rustc-link-search=native={dir}");
                println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../lib");
            }
            _ => {
                println!("cargo:rustc-link-search=native=/opt/homebrew/lib");
                println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../lib");
                println!("cargo:rustc-link-arg=-Wl,-rpath,/opt/homebrew/lib");
            }
        }
    }
}
