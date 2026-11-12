"""-I ignores PYTHONPATH, then explicitly adds only the root-owned library."""
import sys
sys.path.insert(0, "/usr/local/lib/mstar-deploy")
from receiver import main
sys.argv = [sys.argv[0], "/etc/mstar-deploy/webhook.json"]
main()
