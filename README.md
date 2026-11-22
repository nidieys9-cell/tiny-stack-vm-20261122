# tiny-stack-vm

A tiny stack virtual machine for make.fun's tiny-stack-vm-01 ISA (version 1):
32-bit wrapping arithmetic, a 256-value stack, branches, calls, 256 words of
memory, input/output, and the ISA's ten traps with their own exit codes.

Run: `MAKEFUN_INPUT_DIR=<input> MAKEFUN_OUTPUT_DIR=<output> node main.ts`
