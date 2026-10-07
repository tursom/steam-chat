# Release builds use R8 and the dependencies' consumer rules. GIF's JNI classes,
# Media3's reflective factories, and WorkManager's worker constructors are kept
# by those libraries; no blanket application keep rule is needed.
