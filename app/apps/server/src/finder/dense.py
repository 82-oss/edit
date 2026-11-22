# dense.py <tag> <media>: where text is, in the file's caption zone, on every 2nd shown frame -> <media>.dense.jsonl (boxes in whole-picture pixels)
import sys,json,os,cv2,time
from multiprocessing import Pool
tag,mid=sys.argv[1],sys.argv[2]; sys.argv=sys.argv[:3]
import scan
Z=json.load(open(f'{tag}/scan/{mid}.zone.json')); EVERY=2
y0=y1=0
if Z['zone']:
    m=2.5*Z['line'][1]; y0=max(0,int(Z['zone'][0]*Z['H']-m)); y1=min(Z['H'],int(Z['zone'][1]*Z['H']+m))
    if y1-y0<5*Z['line'][2]: y0=max(0,y1-int(5*Z['line'][2]))
eng=None
def work(ab):
    cv2.setNumThreads(2)
    global eng
    if eng is None:
        import ocr; eng=ocr.engine(960,False)
    a,b=ab; cap=cv2.VideoCapture(f'{tag}/src/{mid}.mp4'); fps=cap.get(cv2.CAP_PROP_FPS)
    f0=int(round(a*fps)); f0-=f0%EVERY; f1=int(b*fps); cap.set(cv2.CAP_PROP_POS_FRAMES,f0); out=[]; f=f0
    while f<=f1:
        ok,img=cap.read()
        if not ok: break
        r=eng(img[y0:y1],use_det=True,use_cls=False,use_rec=False); bx=[]
        if r.boxes is not None:
            for q,s in zip(r.boxes,r.scores):
                a0,b0=q.min(0); a1,b1=q.max(0); bx.append([int(a0),int(b0)+y0,int(a1),int(b1)+y0,round(float(s),2)])
        th=cv2.resize(cv2.cvtColor(img,cv2.COLOR_BGR2GRAY),(16,9),interpolation=cv2.INTER_AREA).flatten().tolist()
        out.append({"f":f,"b":bx,"t":th})
        for _ in range(EVERY-1):
            if not cap.grab(): break
        f+=EVERY
    return out
if __name__=='__main__':
    if not Z['zone']: print(mid,'no caption zone'); sys.exit()
    t0=time.time(); n=0
    with Pool(int(os.environ.get('PROCS','4'))) as p, open(f'{tag}/scan/{mid}.dense.jsonl','w') as o:
        for res in p.imap(work,scan.chunks()):
            for r in res: o.write(json.dumps(r)+'\n'); n+=1
    print(mid,n,'reads',round(time.time()-t0),'s')
