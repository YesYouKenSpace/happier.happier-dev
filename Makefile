.PHONY: 

gh.ci.mobile.build:
	gh workflow run build-ui-mobile-local.yml \
		-f environment=preview \
		-f platform=android \
		-f profile=preview-apk \
		-f action=build_only \
		-f publish_apk_release=true \
		-f source_ref=dev
