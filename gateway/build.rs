//! Optional modules: `src/ext/` holds an instance's own screens and is not part of the public tree. When it is there,
//! it is compiled in (`cfg(ext)`); without it the gateway builds and tests as published.

fn main() {
    println!("cargo::rustc-check-cfg=cfg(ext)");
    println!("cargo::rerun-if-changed=src/ext");
    println!("cargo::rerun-if-env-changed=LUMBRIDGE_ENV_ALIAS");
    println!("cargo::rerun-if-env-changed=LUMBRIDGE_ASR_PRIVATE_LANE");
    println!("cargo::rerun-if-env-changed=LUMBRIDGE_OWNER_ROLE");
    if std::path::Path::new("src/ext/mod.rs").exists() {
        println!("cargo::rustc-cfg=ext");
    }
}
