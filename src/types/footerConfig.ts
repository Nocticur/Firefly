export interface FooterConfig {
	/** Leave empty until the site's own ICP registration is configured. */
	icp: string;
	icpUrl: string;
	/** Show traffic placeholders when no public statistics source is configured. */
	showTraffic: boolean;
}
