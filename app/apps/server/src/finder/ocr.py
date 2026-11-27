# one place that makes the text reader (on the GPU here; in Edit it would be Vision on a Mac, PaddleOCR on Linux)
def engine(side=960,rec=True):
    import onnxruntime as ort; ort.set_default_logger_severity(3)
    if hasattr(ort,"preload_dlls"): ort.preload_dlls()
    from rapidocr import RapidOCR, OCRVersion, ModelType
    p={"Global.log_level":"error","Det.ocr_version":OCRVersion.PPOCRV5,"Det.model_type":ModelType.MOBILE,"Det.limit_side_len":side,"Det.limit_type":"max","Det.box_thresh":0.4,"EngineConfig.onnxruntime.use_cuda":True,"EngineConfig.onnxruntime.intra_op_num_threads":2,"EngineConfig.onnxruntime.inter_op_num_threads":1,"Global.text_score":0.2}
    # Two threads a reader: the card does the work, and ONNX Runtime's default (one per core, spinning) had two scans of
    # two workers each at ~700% apiece, 28 of mandalorian's 32 cores, and nothing else in Edit moved (Nov 27).
    if rec: p.update({"Rec.ocr_version":OCRVersion.PPOCRV5,"Rec.model_type":ModelType.MOBILE})
    return RapidOCR(params=p)
