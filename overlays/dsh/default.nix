{ lib, buildNpmPackage, makeWrapper, callPackage, ... }:

let
  runtimeNode = callPackage ./nodejs.nix { };
in
buildNpmPackage {
  pname = "deepseek-harness";
  version = "0.2.0-rc.2";
  src = ./.;

  npmDepsHash = "sha256-FAoeOutJ1cWb4u2pJWFCxTMVcVTWQshfW5XaOdxs5Qk=";
  dontNpmBuild = true;
  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/dsh $out/bin
    cp -r node_modules $out/lib/dsh/
    makeWrapper ${runtimeNode}/bin/node $out/bin/dsh \
      --add-flags "$out/lib/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" \
      --prefix PATH : ${lib.makeBinPath [ runtimeNode ]}
    runHook postInstall
  '';

  meta = {
    description = "DeepSeek Harness agent CLI";
    homepage = "https://github.com/deepseek-ai/deepseek-harness";
    license = lib.licenses.mit;
    mainProgram = "dsh";
    platforms = [ "x86_64-linux" ];
  };
}
