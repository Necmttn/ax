# Activity-first tracer context instead of eager full-repo indexing

`agentctl` will generate Tracer Context around Files that were touched by commits, edited by agents, or explicitly queried before considering full-repo indexing. This keeps the product centred on agent work memory rather than becoming an eager static-analysis daemon, while still allowing import neighbors and richer code IR to be expanded on demand when trace queries need them.
