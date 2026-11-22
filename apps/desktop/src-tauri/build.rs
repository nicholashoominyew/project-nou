fn main() {
    // Windows embeds icons/icon.ico into the exe once. Without this line a changed icon is not picked up until a clean build.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build();
}
