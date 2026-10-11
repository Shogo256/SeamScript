{ pkgs ? import (fetchTarball {
    # Same revision the flake pins, so `nix-shell` and `nix develop` agree.
    # If the hash is rejected, nix prints the correct one: paste it here.
    url = "https://github.com/NixOS/nixpkgs/archive/31cd72fdba8fa052e437ce7e6879c4fe62def10f.tar.gz";
    sha256 = "sha256-VI5cdo27nEZ3m1SlgB8RvBbrqFUO2/dUgrrLWe407oA=";
  }) {} }:
pkgs.mkShell {
  packages = with pkgs; [
    # regulars
    gfortran
    gnat         # 15.x: must match gprbuild and gnatprove's frontend generation
    gnatprove    # SPARK; nixpkgs derives its fsf-NN from the gnat above
    gprbuild
    coq          # 9.1 wraps rocq; coqc still exists and reports "The Rocq Prover"
    lean4        # second proof layer: mathlib's analysis / measure theory, which coq lacks.
                 # split of duty is by subject, not by tool: coq for compilers, systems,
                 # concurrency (iris); lean for the mathematical side.
    verible      # SystemVerilog lint / format / LSP (no simulation, no synthesis)
    iverilog     # Icarus 13.x: the actual simulator. -g2012 for the SV subset, 4-state
    verilator    # 2-state, compiles to C++. for bulk trace generation once iverilog drags
    yosys        # RTL frontend sby reads through; `sat` alone covers small BMC / equiv
    sby          # SymbiYosys. the attr is `sby`, not `symbiyosys`
    bitwuzla     # bitvector-specialized; beats the generic z3 on RTL proof obligations
    gtkwave      # waveform viewer; used to eyeball VCD while debugging the parser,
                 # and to open the counterexample VCD sby drops on a failed assert
    nodejs_24
    typescript
    yarn
    rustc
    cargo
    clippy
    rustfmt
    rust-analyzer
    (python3.withPackages (ps: with ps; [
      z3-solver
      hypothesis
      duckdb
      numpy
      scipy       
      matplotlib
      jax         # CPU build. cudaSupport would rebuild most of the CUDA closure.
      jaxlib
    ]))
    # reserves
    ocaml
    dune_3
    opam
    cbqn
    ngn-k
    beamPackages.elixir   # brings OTP
    beamPackages.erlang   # for erl / observer
    sbcl
    # tlaplus / jdk21     # dropped: TLC needs a frozen spec, and the JVM was the
                          # single heaviest thing entered on every shell start.
    # fstar               # not from nixpkgs at this rev: the z3 4.8.5 it pins (see
                          # by-name/fs/fstar/z3) fails its python bindings with
                          # "No module named 'pkg_resources'" -- gone from python 3.14.
                          # the z3 binary itself builds fine; only the bindings die, and
                          # fstarZ3 sits inside the package.nix `let`, so no overlay reaches it.
                          # lives in opam instead:
                          #   opam init --bare --no-setup
                          #   opam switch create fstar 5.3.0
                          #   opam install fstar --switch=fstar
                          # deliberately NOT sourced in shellHook: run
                          #   eval $(opam env --switch=fstar)
                          # by hand, so the opam ocaml never shadows the ocaml above.
    # tools
    z3
    llvm_19
    llvmPackages_19.clang
    binutils
    pkg-config
    cmake        # gnumake already comes from stdenv
    git
    # debug / profile
    gdb
    llvmPackages_19.lldb   # matched to clang_19 above, not the top-level lldb 21
    valgrind
    hyperfine
    # linuxPackages.perf  # nixpkgs builds 7.1.3; host kernel is 7.0.0-29-generic.
                          # Ubuntu's /usr/bin/perf matches uname -r and stays on PATH here.
    # direnv              # belongs outside the shell: it is what enters it.
  ];

  # rust-analyzer cannot reach the stdlib source without this.
  RUST_SRC_PATH = "${pkgs.rustPlatform.rustLibSrc}";

  shellHook = ''
    # Printing versions costs ~5s (three python starts, jax import alone is 1-3s),
    # so it no longer runs on entry. Type `versions` when you actually want it.
    versions() {
      echo "fortran    : $(gfortran --version 2>/dev/null | head -n1 || echo '-')"
      echo "gnat       : $(gnat --version 2>/dev/null | head -n1 || echo '-')"
      # keep the fallback inside the pipe: gnatprove's exit status is unreliable
      echo "gnatprove  : $({ gnatprove --version 2>/dev/null || echo '-'; } | head -n1)"
      echo "coq        : $(coqc --version 2>/dev/null | head -n1 || echo '-')"
      echo "lean       : $(lean --version 2>/dev/null | head -n1 || echo '-')"
      # fstar is opam-side, so it only answers after `eval $(opam env --switch=fstar)`
      echo "fstar      : $({ fstar.exe --version 2>/dev/null || echo '-'; } | head -n1)"
      echo "verible    : $(verible-verilog-lint --version 2>/dev/null | head -n1 || echo '-')"
      echo "iverilog   : $(iverilog -V 2>/dev/null | head -n1 || echo '-')"
      echo "verilator  : $(verilator --version 2>/dev/null | head -n1 || echo '-')"
      echo "yosys      : $(yosys -V 2>/dev/null | head -n1 || echo '-')"
      echo "sby        : $({ sby --version 2>/dev/null || echo '-'; } | head -n1)"
      echo "bitwuzla   : $(bitwuzla --version 2>/dev/null | head -n1 || echo '-')"
      echo "gtkwave    : $(gtkwave --version 2>/dev/null | head -n1 || echo '-')"
      echo "typescript : $(tsc --version 2>/dev/null || echo '-')"
      echo "rustc      : $(rustc --version 2>/dev/null || echo '-')"
      # one interpreter start instead of four
      python3 - <<'PY' 2>/dev/null || echo "python     : -"
import sys
print("python     : %d.%d.%d" % sys.version_info[:3])
for name in ("numpy", "scipy", "jax"):
    try:
        print("%-10s : %s" % (name, __import__(name).__version__))
    except Exception:
        print("%-10s : -" % name)
PY
      echo "ocaml      : $(ocaml -version 2>/dev/null || echo '-')"
      echo "bqn        : $(BQN --version 2>/dev/null | head -n1 || echo '-')"
      echo "k          : $(echo '"ok"' | k 2>/dev/null | head -n1 || echo '-')"
      echo "elixir     : $(elixir --version 2>/dev/null | tail -n1 || echo '-')"
      echo "erlang     : $(erl -noshell -eval 'io:format("~s~n",[erlang:system_info(otp_release)]),halt().' 2>/dev/null || echo '-')"
      echo "sbcl       : $(sbcl --version 2>/dev/null || echo '-')"
      echo "z3         : $(z3 --version 2>/dev/null || echo '-')"
    }
    # direnv evaluates .envrc with DIRENV_IN_ENVRC set; staying quiet there stops
    # the banner from printing a second time when `use flake` re-enters the shell.
    if [ -z "''${DIRENV_IN_ENVRC:-}" ]; then
      echo "dev shell ready. \`versions\` to list toolchain versions."
    fi
  '';
}
