.PHONY: check desktop-check android-test desktop-linux
check: desktop-check android-test
desktop-check:
	cd apps/desktop && npm run check
android-test:
	cd apps/android && gradle --no-daemon :app:testDebugUnitTest
desktop-linux:
	cd apps/desktop && npm run dist:linux -- --publish never
