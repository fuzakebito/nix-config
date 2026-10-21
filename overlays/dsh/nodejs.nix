{ lib, stdenv, fetchurl, autoPatchelfHook, ... }:

# dsh's native loader inspects Node machine code. Nix-built Node is unsupported;
# use the official binary privately, without replacing the user's Node.js.
stdenv.mkDerivation rec {
  pname = "dsh-nodejs-bin";
  version = "24.21.0";

  src = fetchurl {
    url = "https://nodejs.org/dist/v${version}/node-v${version}-linux-x64.tar.xz";
    sha256 = "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6";
  };

  nativeBuildInputs = [ autoPatchelfHook ];
  # Sorting this upstream ELF's program headers makes the newer glibc loader crash.
  patchelfFlags = [ "--no-sort" ];
  buildInputs = [ stdenv.cc.cc.lib ];
  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    install -Dm755 bin/node $out/bin/node
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    $out/bin/node --version
    runHook postInstallCheck
  '';

  meta = {
    description = "Official Node.js runtime for DeepSeek Harness";
    homepage = "https://nodejs.org/";
    license = lib.licenses.mit;
    platforms = [ "x86_64-linux" ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
