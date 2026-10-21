{ lib, stdenvNoCC, fetchurl, makeWrapper, dsh }:

stdenvNoCC.mkDerivation rec {
  pname = "rustdsh";
  version = "0.3.3";

  # Static musl release also works on NixOS without an ELF interpreter patch.
  src = fetchurl {
    url = "https://github.com/jimoto-no-llm/rustdsh/releases/download/v${version}/rdsh-linux-x64-musl.tar.gz";
    sha256 = "112ca441273d97b84423f017ee7b4e8ac8bfc9d8fa8cc7ba55471c71ccb18c0a";
  };

  sourceRoot = ".";
  nativeBuildInputs = [ makeWrapper ];
  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    install -Dm755 rdsh $out/bin/rdsh
    wrapProgram $out/bin/rdsh --prefix PATH : ${lib.makeBinPath [ dsh ]}
    runHook postInstall
  '';

  meta = {
    description = "Rust launcher for DeepSeek Harness";
    homepage = "https://github.com/jimoto-no-llm/rustdsh";
    license = lib.licenses.mit;
    mainProgram = "rdsh";
    platforms = [ "x86_64-linux" ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
