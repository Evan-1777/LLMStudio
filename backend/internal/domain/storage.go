package domain

// StorageUsage describes the on-disk footprint of the gateway database. Paths are
// deliberately not part of the contract.
type StorageUsage struct {
	MainBytes   int64 `json:"mainBytes"`
	WALBytes    int64 `json:"walBytes"`
	TotalBytes  int64 `json:"totalBytes"`
	Compactable bool  `json:"compactable"`
}

// StorageCompactResult reports the space reclaimed by one online compaction.
type StorageCompactResult struct {
	BeforeBytes int64        `json:"beforeBytes"`
	AfterBytes  int64        `json:"afterBytes"`
	FreedBytes  int64        `json:"freedBytes"`
	Usage       StorageUsage `json:"usage"`
}
