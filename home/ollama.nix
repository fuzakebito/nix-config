{ ... }:

{
  # Local LLM runner. Idle daemon is cheap (listens on 127.0.0.1:11434,
  # models load on demand and unload after OLLAMA_KEEP_ALIVE, default 5min).
  # Set `acceleration = "cuda"` or `"rocm"` here if GPU offload is wanted.
  services.ollama = {
    enable = true;
  };
}
