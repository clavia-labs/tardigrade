import os
import sys

for directory, _, files in os.walk(sys.argv[1]):
    for name in files:
        path = os.path.join(directory, name)
        with open(path, "rb") as file:
            os.fsync(file.fileno())
